import prisma from "../db/connect";
import { BookingStatus } from "@prisma/client";

// ── Date helpers ───────────────────────────────────────────────────────────────

/** Parse an ISO date string (YYYY-MM-DD) and return a UTC-midnight Date. */
function toUtcDate(d: string | Date): Date {
  if (d instanceof Date) {
    const r = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    return r;
  }
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Expand [start, end) into an array of UTC-midnight Dates (nights). */
function nightRange(start: Date, end: Date): Date[] {
  const nights: Date[] = [];
  let cur = start;
  while (cur < end) {
    nights.push(cur);
    cur = addDays(cur, 1);
  }
  return nights;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CalendarCell {
  availableRooms: number;   // effective available (override or computed)
  totalRooms:     number;
  bookedRooms:    number;   // active bookings covering this night
  price:          number;   // override price or basePrice
  isOverridden:   boolean;  // true = explicit RoomInventory row exists
}

export interface CalendarResult {
  roomTypes: { id: string; name: string; basePrice: number; totalRooms: number }[];
  dates:     string[];                                       // YYYY-MM-DD strings
  cells:     Record<string, Record<string, CalendarCell>>;  // roomTypeId → dateStr → cell
}

// ── Calendar query ─────────────────────────────────────────────────────────────

export async function getCalendarData(
  hotelId:   string,
  startDate: string,
  endDate:   string
): Promise<CalendarResult> {
  const start = toUtcDate(startDate);
  const end   = toUtcDate(endDate);
  const nights = nightRange(start, end);
  const dateStrs = nights.map((d) => d.toISOString().slice(0, 10));

  const [roomTypes, inventoryRows, bookings] = await Promise.all([
    prisma.roomType.findMany({
      where: { hotelId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, basePrice: true, totalRooms: true },
    }),
    prisma.roomInventory.findMany({
      where: {
        hotelId,
        date: { gte: start, lte: addDays(end, -1) },
      },
    }),
    prisma.booking.findMany({
      where: {
        hotelId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.HOLD] },
        checkIn:  { lt: end },
        checkOut: { gt: start },
      },
      select: { roomTypeId: true, checkIn: true, checkOut: true },
    }),
  ]);

  // Index inventory by roomTypeId + dateStr
  const invMap: Record<string, Record<string, { availableRooms: number; price: number | null }>> = {};
  for (const row of inventoryRows) {
    const rid = row.roomTypeId;
    const ds  = row.date.toISOString().slice(0, 10);
    if (!invMap[rid]) invMap[rid] = {};
    invMap[rid]![ds] = { availableRooms: row.availableRooms, price: row.price };
  }

  // Count booked rooms per roomType per night
  const bookedMap: Record<string, Record<string, number>> = {};
  for (const b of bookings) {
    const ci = toUtcDate(b.checkIn);
    const co = toUtcDate(b.checkOut);
    for (const night of nightRange(ci, co)) {
      const ds = night.toISOString().slice(0, 10);
      if (!dateStrs.includes(ds)) continue;
      if (!bookedMap[b.roomTypeId]) bookedMap[b.roomTypeId] = {};
      bookedMap[b.roomTypeId]![ds] = (bookedMap[b.roomTypeId]![ds] ?? 0) + 1;
    }
  }

  // Build cell grid
  const cells: CalendarResult["cells"] = {};
  for (const rt of roomTypes) {
    cells[rt.id] = {};
    for (const ds of dateStrs) {
      const inv       = invMap[rt.id]?.[ds];
      const booked    = bookedMap[rt.id]?.[ds] ?? 0;
      const total     = rt.totalRooms;
      const isOverridden = inv !== undefined;
      const available = isOverridden
        ? inv!.availableRooms
        : Math.max(0, total - booked);
      const price = inv?.price ?? rt.basePrice;
      cells[rt.id]![ds] = { availableRooms: available, totalRooms: total, bookedRooms: booked, price, isOverridden };
    }
  }

  return { roomTypes, dates: dateStrs, cells };
}

// ── Single cell upsert ─────────────────────────────────────────────────────────

export async function upsertInventoryCell(
  hotelId:        string,
  roomTypeId:     string,
  date:           string,
  availableRooms: number,
  price?:         number | null
) {
  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
  if (!rt) throw new Error("Room type not found");
  if (availableRooms < 0 || availableRooms > rt.totalRooms) {
    throw new Error(`availableRooms must be 0–${rt.totalRooms}`);
  }
  const d = toUtcDate(date);
  return prisma.roomInventory.upsert({
    where: { roomTypeId_date: { roomTypeId, date: d } },
    update: { availableRooms, price: price ?? null },
    create: { hotelId, roomTypeId, date: d, availableRooms, price: price ?? null },
  });
}

// ── Bulk upsert ────────────────────────────────────────────────────────────────

export async function bulkUpsertInventory(
  hotelId:        string,
  roomTypeId:     string,
  startDate:      string,
  endDate:        string,
  availableRooms: number,
  price?:         number | null
) {
  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
  if (!rt) throw new Error("Room type not found");
  if (availableRooms < 0 || availableRooms > rt.totalRooms) {
    throw new Error(`availableRooms must be 0–${rt.totalRooms}`);
  }
  const nights = nightRange(toUtcDate(startDate), toUtcDate(endDate));
  if (nights.length > 365) throw new Error("Range must not exceed 365 days");

  await Promise.all(
    nights.map((d) =>
      prisma.roomInventory.upsert({
        where: { roomTypeId_date: { roomTypeId, date: d } },
        update: { availableRooms, price: price ?? null },
        create: { hotelId, roomTypeId, date: d, availableRooms, price: price ?? null },
      })
    )
  );
  return { updated: nights.length };
}

// ── Bot availability check ─────────────────────────────────────────────────────

export async function checkRoomAvailability(
  hotelId:    string,
  roomTypeId: string,
  checkIn:    string | Date,
  checkOut:   string | Date
): Promise<{ available: boolean; availableCount: number }> {
  const ci = toUtcDate(checkIn);
  const co = toUtcDate(checkOut);
  const nights = nightRange(ci, co);
  if (!nights.length) return { available: false, availableCount: 0 };

  const [rt, inventoryRows, bookings] = await Promise.all([
    prisma.roomType.findUnique({ where: { id: roomTypeId }, select: { totalRooms: true } }),
    prisma.roomInventory.findMany({
      where: { roomTypeId, date: { gte: ci, lt: co } },
      select: { date: true, availableRooms: true },
    }),
    prisma.booking.findMany({
      where: {
        hotelId,
        roomTypeId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.HOLD] },
        checkIn:  { lt: co },
        checkOut: { gt: ci },
      },
      select: { checkIn: true, checkOut: true },
    }),
  ]);

  if (!rt) return { available: false, availableCount: 0 };

  const invByDate: Record<string, number> = {};
  for (const row of inventoryRows) {
    invByDate[row.date.toISOString().slice(0, 10)] = row.availableRooms;
  }

  // Count bookings per night
  const bookedByDate: Record<string, number> = {};
  for (const b of bookings) {
    for (const night of nightRange(toUtcDate(b.checkIn), toUtcDate(b.checkOut))) {
      const ds = night.toISOString().slice(0, 10);
      bookedByDate[ds] = (bookedByDate[ds] ?? 0) + 1;
    }
  }

  let minAvailable = Infinity;
  for (const night of nights) {
    const ds       = night.toISOString().slice(0, 10);
    const cap      = invByDate[ds] !== undefined ? invByDate[ds]! : rt.totalRooms;
    const booked   = bookedByDate[ds] ?? 0;
    const avail    = Math.max(0, cap - booked);
    if (avail < minAvailable) minAvailable = avail;
  }

  const availableCount = minAvailable === Infinity ? rt.totalRooms : minAvailable;
  return { available: availableCount > 0, availableCount };
}

// ── Availability toggle ────────────────────────────────────────────────────────

export async function getAvailabilityEnabled(hotelId: string): Promise<boolean> {
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  return config?.availabilityEnabled ?? false;
}

export async function setAvailabilityEnabled(hotelId: string, enabled: boolean): Promise<void> {
  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: { availabilityEnabled: enabled },
    create: { hotelId, availabilityEnabled: enabled },
  });
}
