/**
 * One-off cleanup: VKT-2026-00015 through VKT-2026-00019 are five Booking rows
 * that should have been a single group booking. This script:
 *   1. Creates five BookingRoom child rows on the keeper (VKT-2026-00015),
 *      one per original Booking, with the per-room pricing.
 *   2. Updates the keeper's totalPrice to the correct ₹74,000 group total.
 *   3. Deletes the four duplicate Booking rows (00016–00019).
 *      Guest records are untouched — guestId FK only lives on Booking rows.
 */
import prisma from "../src/db/connect";

const KEEP_ID   = "bd0e8ac4-6ad8-46b9-b9e8-bc9e49a3d286"; // VKT-2026-00015
const DELETE_IDS = [
  "dedbd422-71ad-43eb-b996-f4cc6c8a2afc", // VKT-2026-00016
  "c709cf23-1fe0-410d-85a6-54d9c7599926", // VKT-2026-00017
  "fc97aeda-0edb-4a86-b4c3-a8da74f43b1b", // VKT-2026-00018
  "1d1ab76b-cab0-414b-8e88-fa8eadb3a84e", // VKT-2026-00019
];
const ROOM_TYPE_ID = "5e7ceb5a-b223-4e06-bce6-88611debe2ae";

// Per-room data from the original rows (2 nights each)
const ROOMS = [
  { pricePerNight: 8000, totalPrice: 16000 }, // was 00015
  { pricePerNight: 8000, totalPrice: 16000 }, // was 00016
  { pricePerNight: 8000, totalPrice: 16000 }, // was 00017
  { pricePerNight: 6500, totalPrice: 13000 }, // was 00018
  { pricePerNight: 6500, totalPrice: 13000 }, // was 00019
];
const GRAND_TOTAL = ROOMS.reduce((s, r) => s + r.totalPrice, 0); // 74000

async function run() {
  await prisma.$transaction(async (tx) => {
    // 1. Insert BookingRoom children on the keeper
    for (const r of ROOMS) {
      await tx.bookingRoom.create({
        data: {
          bookingId:    KEEP_ID,
          roomTypeId:   ROOM_TYPE_ID,
          adults:       2,
          children:     0,
          extraBed:     false,
          pricePerNight: r.pricePerNight,
          totalPrice:   r.totalPrice,
        },
      });
    }

    // 2. Update keeper total to the correct group total
    await tx.booking.update({
      where: { id: KEEP_ID },
      data:  { totalPrice: GRAND_TOTAL },
    });

    // 3. Delete the four duplicate rows
    await tx.booking.deleteMany({ where: { id: { in: DELETE_IDS } } });
  });

  console.log(`Consolidated. Keeper: VKT-2026-00015 (${KEEP_ID})`);
  console.log(`Total set to ₹${GRAND_TOTAL.toLocaleString("en-IN")}`);
  console.log(`Deleted: ${DELETE_IDS.length} duplicate booking rows`);

  // Verify
  const kept = await prisma.booking.findUnique({
    where:   { id: KEEP_ID },
    include: { rooms: true },
  });
  console.log(`\nFinal state:`);
  console.log(`  referenceNumber: ${kept?.referenceNumber}`);
  console.log(`  totalPrice:      ₹${kept?.totalPrice.toLocaleString("en-IN")}`);
  console.log(`  BookingRoom rows: ${kept?.rooms.length}`);

  await prisma.$disconnect();
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
