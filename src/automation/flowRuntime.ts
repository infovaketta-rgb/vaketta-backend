/**
 * flowRuntime.ts
 *
 * Executes one step of a visual flow for a given guest session.
 * Called when session.state starts with "FLOW:{flowId}:{nodeId}".
 *
 * Node types handled:
 *   start, message, question, branch, action, end,
 *   check_availability, show_rooms
 *
 * Question types:
 *   text, room_selection (legacy), date, number, yes_no, rating
 *
 * Action types:
 *   create_booking, cancel_booking, update_booking_status, start_booking_flow (legacy),
 *   handoff_to_staff, notify_staff, reset_to_menu, set_variable, send_review_request, view_bookings
 */

import * as chrono from "chrono-node";
import prisma from "../db/connect";
import { logger } from "../utils/logger";

const log = logger.child({ service: "flow-runtime" });
import { updateSession, resetSession, SessionData } from "../services/session.service";
import { buildMenuMessage } from "./buildMenuResponse";
import { checkRoomAvailability, getCalendarData } from "../services/availability.service";
import {
  SerializedFlowNode,
  SerializedFlowEdge,
  MessageNodeData,
  QuestionNodeData,
  DelayNodeData,
  BranchNodeData,
  BranchCondition,
  ActionNodeData,
  CheckAvailabilityNodeData,
  ShowRoomsNodeData,
  EndNodeData,
  JumpNodeData,
} from "./flowTypes";
import { generateReferenceNumber } from "../utils/booking.utils";
import { cancelBooking } from "../services/booking.service";
import { BookingStatus, MessageChannel, MessageStatus } from "@prisma/client";
import { shouldAutoReply } from "./shouldAutoReply";
import { sendCarouselMessage, sendMediaMessage, type CarouselCard } from "../services/whatsapp.send.service";
import { flowResumeQueue } from "../queue/flowResumeQueue";
import { decryptWhatsAppToken } from "../utils/encryption.utils";
import { getPublishedNodes } from "../services/flow.service";
import { extractDateWithAI, classifyBookingIntent } from "../services/ai.service";

// Generic placeholder served when a room has no photos. Reliable HTTPS host —
// Meta requires a publicly fetchable URL for interactive image headers.
const CAROUSEL_FALLBACK_IMAGE = "https://placehold.co/600x400/png?text=Room";

const MAX_HOPS = 30;
const DIVIDER  = "━━━━━━━━━━━━━━━━";
const MENU_FALLBACK = "Reply *MENU* to see our options.";

const ACTION_TIMEOUT_MS = 10_000;
function withActionTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Action timeout")), ACTION_TIMEOUT_MS)
    ),
  ]);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildMaps(nodes: SerializedFlowNode[], edges: SerializedFlowEdge[]) {
  const nodeMap = new Map<string, SerializedFlowNode>(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, { targetId: string; sourceHandle: string | null | undefined }[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? [];
    list.push({ targetId: e.target, sourceHandle: e.sourceHandle });
    adjacency.set(e.source, list);
  }
  return { nodeMap, adjacency };
}

function nextNodeId(
  nodeId: string,
  adjacency: Map<string, { targetId: string; sourceHandle: string | null | undefined }[]>,
  handle?: string
): string | null {
  const edges = adjacency.get(nodeId) ?? [];
  if (!handle) return edges[0]?.targetId ?? null;
  return edges.find((e) => e.sourceHandle === handle)?.targetId ?? null;
}

function evaluateCondition(cond: BranchCondition, flowVars: Record<string, string>): boolean {
  const actual  = (flowVars[cond.variable] ?? "").toLowerCase().trim();
  // Support {{varName}} interpolation in compareValue so admins can compare two variables
  const compare = interpolate(cond.compareValue, flowVars).toLowerCase().trim();
  switch (cond.operator) {
    case "equals":      return actual === compare;
    case "not_equals":  return actual !== compare;
    case "contains":    return actual.includes(compare);
    case "starts_with": return actual.startsWith(compare);
    case "gt":          return parseFloat(actual) > parseFloat(compare);
    case "lt":          return parseFloat(actual) < parseFloat(compare);
    default:            return false;
  }
}

/** Parse DD/MM/YYYY or YYYY-MM-DD into a Date (midnight UTC). Returns null on failure. */
function parseFlexDate(raw: string): Date | null {
  const m1 = raw.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) {
    const d = new Date(`${m1[3]}-${m1[2]!.padStart(2, "0")}-${m1[1]!.padStart(2, "0")}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const m2 = raw.trim().match(/^\d{4}-\d{2}-\d{2}$/);
  if (m2) {
    const d = new Date(`${raw.trim()}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Parse any natural-language date string from a guest. Tries chrono-node first; falls back to AI extraction. */
async function parseGuestDate(input: string): Promise<Date | null> {
  const chronoResult = chrono.parseDate(input.trim(), new Date(), { forwardDate: true }) ?? null;
  if (chronoResult) return chronoResult;
  return extractDateWithAI(input);
}

/** Normalise date to YYYY-MM-DD string */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC today */
function todayUTC(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Replace {{varName}} or {{obj.field}} placeholders in text with values from flowVars. */
function interpolate(text: string, flowVars: Record<string, string>): string {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, key) => flowVars[key] ?? `{{${key}}}`);
}

// Variable names that are injected by the runtime or set by action nodes from
// DB-verified data. A flow admin naming a *question* node with one of these
// keys would allow a guest to overwrite them with arbitrary text input.
const RESERVED_FLOW_VARS = new Set([
  // Runtime-injected read-only variables
  "hotelName", "guestName", "guestPhone",
  "currentDate", "currentTime", "currentDay", "__sysInjected__",
  // Internal room list cache used between show_rooms phases
  "__roomList__",
  // Set by show_rooms / room_selection from DB — never from raw guest text
  "bookingRoomTypeId", "bookingRoomTypeName", "bookingPricePerNight",
  // Set by check_availability node
  "availabilityResult", "availabilityCount",
  // Set by create_booking action result
  "bookingRef", "bookingId", "bookingStatus",
  // Set by notify_staff action
  "staffNotified",
]);

// Prototype-pollution keys that must never appear as variable names regardless
// of context.
const BLOCKED_VAR_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Internal runtime variables that start with __ — only the runtime itself
// should write these; guest input must never be allowed to set them.
const INTERNAL_DOUBLE_UNDERSCORE = new Set([
  "__flowError__", "__cancelSuccess__", "__roomList__", "__sysInjected__",
]);

/** Write a guest-collected answer into flowVars, rejecting reserved key names. */
function safeSetVar(
  flowVars: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  if (!key || RESERVED_FLOW_VARS.has(key)) return flowVars;
  if (BLOCKED_VAR_KEYS.has(key)) {
    log.warn({ key }, "safeSetVar: blocked prototype-pollution key");
    return flowVars;
  }
  if (key.startsWith("__") && !INTERNAL_DOUBLE_UNDERSCORE.has(key)) {
    log.warn({ key }, "safeSetVar: blocked unlisted internal-namespace key");
    return flowVars;
  }
  return { ...flowVars, [key]: value };
}

async function safeMenu(hotelId: string): Promise<string | null> {
  return (await buildMenuMessage(hotelId)) ?? MENU_FALLBACK;
}

// ── Room carousel sender ──────────────────────────────────────────────────────

/**
 * Attempts to send the visual room carousel for show_rooms phase 1. Resolves
 * hotel WhatsApp credentials, fetches the lead photo per room, dispatches the
 * carousel through the Cloud API, and persists an outbound CAROUSEL message.
 *
 * Returns true if the carousel was sent (caller should NOT also send text);
 * false on any failure or missing config (caller falls back to the text list).
 */
async function trySendRoomCarousel(args: {
  hotelId:      string;
  guestId:      string;
  displayRooms: {
    id:                   string;
    name:                 string;
    basePrice:            number;
    description:          string | null;
    carouselButtonLabel?: string | null;
  }[];
  promptText:   string;
}): Promise<boolean> {
  const { hotelId, guestId, displayRooms, promptText } = args;
  // Meta requires at least 2 cards in a carousel
  if (displayRooms.length < 2) return false;

  // Honour the same dev/test guard the text sender uses. Without this, a
  // mock-mode environment with leftover real credentials would POST to Meta.
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return false;

  try {
    const [hotel, guest] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId }, include: { config: true } }),
      prisma.guest.findUnique({ where: { id: guestId } }),
    ]);
    if (!hotel || !guest) return false;

    const cfg = hotel.config;
    const phoneNumberId = cfg?.metaPhoneNumberId ?? "";
    const encryptedTok  = cfg?.metaAccessTokenEncrypted ?? "";
    if (!phoneNumberId || !encryptedTok) return false;
    const accessToken = decryptWhatsAppToken(encryptedTok);

    // Lead photo per room (isMain first, then lowest order).
    const photos = await prisma.roomPhoto.findMany({
      where:   { roomTypeId: { in: displayRooms.map((r) => r.id) } },
      orderBy: [{ isMain: "desc" }, { order: "asc" }],
      select:  { roomTypeId: true, url: true },
    });
    const photoByRoom = new Map<string, string>();
    for (const p of photos) {
      if (!photoByRoom.has(p.roomTypeId)) photoByRoom.set(p.roomTypeId, p.url);
    }

    // Build unique button titles: use custom label (if not default) else room
    // name, max 18 chars base so dedup suffixes fit within Meta's 20-char cap.
    const baseTitles = displayRooms.map((r) => {
      const label = r.carouselButtonLabel ?? "Select Room";
      return (label !== "Select Room" ? label : r.name).slice(0, 18);
    });

    // Count how many times each base title appears
    const titleFreq = new Map<string, number>();
    for (const t of baseTitles) titleFreq.set(t, (titleFreq.get(t) ?? 0) + 1);

    // Assign suffixes only to titles that collide
    const counters = new Map<string, number>();
    const uniqueTitles = baseTitles.map((t) => {
      if ((titleFreq.get(t) ?? 1) <= 1) return t;
      const n = (counters.get(t) ?? 0) + 1;
      counters.set(t, n);
      return `${t} ${n}`;
    });

    const cards: CarouselCard[] = displayRooms.map((r, i) => ({
      imageUrl:    photoByRoom.get(r.id) ?? CAROUSEL_FALLBACK_IMAGE,
      title:       r.name,
      price:       r.basePrice,
      description: (r.description ?? "").slice(0, 60) || "Comfortable stay",
      buttonId:    `room_${r.id}`,
      buttonLabel: uniqueTitles[i]!,
    }));

    const wamid = await sendCarouselMessage(guest.phone, phoneNumberId, accessToken, promptText, cards);

    const saved = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   hotel.phone,
        toPhone:     guest.phone,
        body:        JSON.stringify({ cards }),
        messageType: "carousel",
        hotelId,
        guestId,
        channel:     MessageChannel.WHATSAPP,
        status:      MessageStatus.SENT,
        wamid,
      },
    });

    const { emitToHotel } = await import("../realtime/emit");
    emitToHotel(hotelId, "message:new", { message: saved });

    return true;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "carousel send failed — falling back to text list");
    return false;
  }
}

// ── Room type fetcher ──────────────────────────────────────────────────────────

async function fetchRoomTypes(hotelId: string, filters?: {
  minCapacity?: number;
  minAdults?:   number;
  minChildren?: number;
}) {
  return prisma.roomType.findMany({
    where: {
      hotelId,
      ...(filters?.minCapacity ? { capacity:    { gte: filters.minCapacity } } : {}),
      ...(filters?.minAdults   ? { maxAdults:   { gte: filters.minAdults   } } : {}),
      ...(filters?.minChildren ? { maxChildren: { gte: filters.minChildren } } : {}),
    },
    orderBy: { basePrice: "asc" },
    select: {
      id: true, name: true, basePrice: true,
      capacity: true, maxAdults: true, maxChildren: true,
      description: true,
      carouselButtonLabel: true,
    },
  });
}

function buildRoomListText(
  promptText: string,
  rooms: {
    id: string; name: string; basePrice: number;
    capacity: number | null; maxAdults: number | null; maxChildren: number | null;
    description: string | null; availableCount?: number;
  }[]
): string {
  if (!rooms.length) {
    return `${promptText}\n\n_No rooms are currently available for those dates. Please try different dates or contact us directly._`;
  }
  let text = `${promptText}\n\n${DIVIDER}\n`;
  rooms.forEach((r, i) => {
    const avail = r.availableCount !== undefined ? ` _(${r.availableCount} avail)_` : "";
    text += `*${i + 1}.* ${r.name}${avail} — ₹${r.basePrice.toLocaleString("en-IN")}/night\n`;
    const parts: string[] = [];
    // Show adults + children if set, otherwise fall back to total capacity
    if (r.maxAdults != null && r.maxAdults > 0) {
      const childPart = r.maxChildren != null && r.maxChildren > 0
        ? ` + ${r.maxChildren} child${r.maxChildren > 1 ? "ren" : ""}`
        : "";
      parts.push(`${r.maxAdults} adult${r.maxAdults > 1 ? "s" : ""}${childPart}`);
    } else if (r.capacity != null && r.capacity > 0) {
      parts.push(`Fits ${r.capacity} guest${r.capacity > 1 ? "s" : ""}`);
    }
    if (r.description) parts.push(r.description.length > 60 ? r.description.slice(0, 57) + "…" : r.description);
    if (parts.length) text += `     _${parts.join(" · ")}_\n`;
  });
  text += `${DIVIDER}\n\n_Reply with a number (1–${rooms.length}).  Type *MENU* to cancel._`;
  return text;
}


// ── Main entry point ───────────────────────────────────────────────────────────

export async function executeFlowStep(
  hotelId:     string,
  guestId:     string,
  state:       string,    // "FLOW:{flowId}:{nodeId}"
  sessionData: SessionData,
  input:       string
): Promise<string | null> {
  const parts  = state.split(":");
  const flowId = parts[1]!;
  const nodeId = parts[2]!;

  const flowContent = await getPublishedNodes(flowId);
  if (!flowContent) {
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId);
  }

  const { nodes, edges } = flowContent;
  const { nodeMap, adjacency } = buildMaps(nodes, edges);

  type FlowData = { flowId: string; flowVars: Record<string, string>; waitingFor?: "answer"; lastInput?: string };
  const rawFlow = sessionData.flow as any;
  let flowData: FlowData;
  if (
    rawFlow !== null &&
    rawFlow !== undefined &&
    typeof rawFlow === "object" &&
    typeof rawFlow.flowVars === "object" &&
    rawFlow.flowVars !== null
  ) {
    flowData = rawFlow as FlowData;
  } else {
    if (rawFlow !== null && rawFlow !== undefined) {
      log.warn({ guestId, sessionFlowType: typeof rawFlow }, "session: corrupted flow data — resetting to defaults");
    }
    flowData = { flowId, flowVars: {} };
  }
  let hops = 0;

  // Fetch hotel config once — used for both system-var injection (timezone) and
  // the business-hours gate inside advance().
  const hotelCfg = await prisma.hotelConfig.findUnique({
    where:  { hotelId },
    select: {
      autoReplyEnabled:  true,
      businessStartHour: true,
      businessEndHour:   true,
      timezone:          true,
      allDay:            true,
    },
  });

  // ── Inject system variables (available in every flow, every node) ────────────
  // These are read-only runtime values. They're injected once per execution so
  // that guest input cannot overwrite them.
  if (!flowData.flowVars["__sysInjected__"]) {
    const hotel = await prisma.hotel.findUnique({
      where:  { id: hotelId },
      select: { name: true },
    });
    const guest = await prisma.guest.findUnique({
      where:  { id: guestId },
      select: { name: true, phone: true },
    });
    const tz  = hotelCfg?.timezone ?? "UTC";
    const now = new Date();
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      now.toLocaleString("en-IN", { timeZone: tz, ...opts });

    flowData.flowVars = {
      hotelName:   hotel?.name   ?? "",
      guestName:   guest?.name   ?? "",
      guestPhone:  guest?.phone  ?? "",
      currentDate: fmt({ year: "numeric", month: "long",  day: "numeric" }),
      currentTime: fmt({ hour: "2-digit", minute: "2-digit", hour12: true }),
      currentDay:  fmt({ weekday: "long" }),
      __sysInjected__: "1",
      ...flowData.flowVars,  // guest-collected vars take precedence over system defaults
    };
  }

  return advance(nodeId);

  async function advance(currentNodeId: string): Promise<string | null> {
    if (++hops > MAX_HOPS) {
      log.error({ flowId, guestId, lastNode: currentNodeId }, `MAX_HOPS(${MAX_HOPS}) exceeded — likely infinite loop`);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId);
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId);
    }

    // ── Business hours gate ──────────────────────────────────────────────────
    // Any node can carry businessHoursOnly=true (set via the inspector panel).
    // We use lastHandledByStaff=false so the check is purely time-based —
    // staff handling status is irrelevant to whether hours are open.
    if ((node.data as any).businessHoursOnly === true && hotelCfg) {
      const mode = shouldAutoReply(
        {
          autoReplyEnabled:  hotelCfg.autoReplyEnabled,
          businessStartHour: hotelCfg.businessStartHour,
          businessEndHour:   hotelCfg.businessEndHour,
          timezone:          hotelCfg.timezone,
          allDay:            hotelCfg.allDay,
        },
        false,
      );
      if (mode === "NIGHT") {
        // Keep session at this node so the guest can retry when hours open.
        await updateSession(guestId, hotelId, state, { ...sessionData, flow: { ...flowData } });
        const outsideMsg =
          ((node.data as any).outsideHoursMessage as string | undefined)?.trim() ||
          "This option is only available during our business hours.";
        return outsideMsg;
      }
    }

    switch (node.type) {

      // ── start ───────────────────────────────────────────────────────────────
      case "start": {
        const next = nextNodeId(currentNodeId, adjacency);
        if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
        return advance(next);
      }

      // ── message ─────────────────────────────────────────────────────────────
      case "message": {
        const d    = node.data as MessageNodeData;
        const text = interpolate(d.text || "", flowData.flowVars);
        const next = nextNodeId(currentNodeId, adjacency);

        if (!next) {
          await resetSession(guestId, hotelId);
          return text || safeMenu(hotelId);
        }

        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        const rest = await advance(next);
        if (!text) return rest;
        if (!rest) return text;
        return `${text}\n\n${rest}`;
      }

      // ── question ────────────────────────────────────────────────────────────
      case "question": {
        const d  = node.data as QuestionNodeData;
        const qt = d.questionType ?? "text";

        // ── room_selection (legacy) ────────────────────────────────────────────
        if (qt === "room_selection") {
          if (!flowData.waitingFor) {
            const rooms = await fetchRoomTypes(hotelId);
            const prompt = interpolate(d.text || "Please choose a room type:", flowData.flowVars);
            const listText = buildRoomListText(prompt, rooms);
            const updatedVars = {
              ...flowData.flowVars,
              __roomList__: JSON.stringify(rooms.map(r => ({ id: r.id, name: r.name, price: r.basePrice }))),
            };
            flowData.waitingFor = "answer";
            flowData.flowVars   = updatedVars;
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return listText;
          }

          let rawList: { id: string; name: string; price: number }[] = [];
          try { rawList = JSON.parse(flowData.flowVars["__roomList__"] ?? "[]"); } catch { /* corrupted — treat as empty */ }
          if (!rawList.length) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }

          const num = parseInt(input, 10);
          if (isNaN(num) || num < 1 || num > rawList.length) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || `Please reply with a number between *1* and *${rawList.length}*.`;
          }

          const chosen = rawList[num - 1];
          if (chosen === undefined) {
            await resetSession(guestId, hotelId);
            return "No rooms available for your selection. Please try again.";
          }
          const prefix = d.variableName || "room";
          flowData.flowVars = {
            ...flowData.flowVars,
            [`${prefix}TypeId`]:   chosen.id,
            [`${prefix}TypeName`]: chosen.name,
            [`${prefix}Price`]:    String(chosen.price),
            bookingRoomTypeId:     chosen.id,
            bookingRoomTypeName:   chosen.name,
            bookingPricePerNight:  String(chosen.price),
          };
          delete flowData.waitingFor;

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── date ───────────────────────────────────────────────────────────────
        if (qt === "date") {
          if (!flowData.waitingFor) {
            flowData.waitingFor = "answer";
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return interpolate(d.text || "Please enter a date:", flowData.flowVars);
          }

          const parsed = await parseGuestDate(input);
          if (!parsed) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || "I didn't catch that date 😅 Try something like *25 May* or *25/05/2026*";
          }

          if (d.dateMin === "today" && parsed < todayUTC()) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || "Please enter a *future* date.";
          }

          if (d.dateMaxDays) {
            const maxDate = new Date(todayUTC().getTime() + d.dateMaxDays * 86_400_000);
            if (parsed > maxDate) {
              await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
              return d.validationError || `Please enter a date within the next *${d.dateMaxDays} days*.`;
            }
          }

          const dateStr = toDateStr(parsed);
          flowData.flowVars = safeSetVar(flowData.flowVars, d.variableName, dateStr);
          // Set canonical booking aliases if var name suggests check-in / check-out
          const vl = d.variableName.toLowerCase();
          if (vl.includes("checkin") || vl.includes("check_in") || vl === "checkin")
            flowData.flowVars["bookingCheckIn"] ??= dateStr;
          if (vl.includes("checkout") || vl.includes("check_out") || vl === "checkout")
            flowData.flowVars["bookingCheckOut"] ??= dateStr;

          delete flowData.waitingFor;
          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── number ─────────────────────────────────────────────────────────────
        if (qt === "number") {
          if (!flowData.waitingFor) {
            flowData.waitingFor = "answer";
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return interpolate(d.text || "Please enter a number:", flowData.flowVars);
          }

          const num = parseFloat(input.trim().replace(/,/g, ""));
          if (isNaN(num)) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || "Please enter a valid *number*.";
          }
          if (d.numberMin !== undefined && num < d.numberMin) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || `The minimum value is *${d.numberMin}*.`;
          }
          if (d.numberMax !== undefined && num > d.numberMax) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || `The maximum value is *${d.numberMax}*.`;
          }

          flowData.flowVars = safeSetVar(flowData.flowVars, d.variableName, String(num));
          delete flowData.waitingFor;
          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── yes_no ─────────────────────────────────────────────────────────────
        if (qt === "yes_no") {
          const yesLabel = d.yesLabel || "Yes";
          const noLabel  = d.noLabel  || "No";

          if (!flowData.waitingFor) {
            flowData.waitingFor = "answer";
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return `${interpolate(d.text || "Please choose:", flowData.flowVars)}\n\nReply *1* for *${yesLabel}* or *2* for *${noLabel}*.`;
          }

          const clean = input.toLowerCase().trim();
          const isYes = clean === "1" || clean === "yes" || clean === "y";
          const isNo  = clean === "2" || clean === "no"  || clean === "n";

          if (!isYes && !isNo) {
            const intent = await classifyBookingIntent(input);
            if (intent === "confirm" || intent === "cancel") {
              flowData.flowVars = safeSetVar(flowData.flowVars, d.variableName, intent === "confirm" ? "yes" : "no");
              delete flowData.waitingFor;
              const next = nextNodeId(currentNodeId, adjacency);
              if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
              await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
              return advance(next);
            }
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || `Please reply *1* for *${yesLabel}* or *2* for *${noLabel}*.`;
          }

          flowData.flowVars = safeSetVar(flowData.flowVars, d.variableName, isYes ? "yes" : "no");
          delete flowData.waitingFor;
          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── rating ─────────────────────────────────────────────────────────────
        if (qt === "rating") {
          const maxStars = d.ratingMax ?? 5;

          if (!flowData.waitingFor) {
            flowData.waitingFor = "answer";
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            const stars = Array.from({ length: maxStars }, (_, i) => `*${i + 1}*`).join(" / ");
            return `${interpolate(d.text || "How would you rate your experience?", flowData.flowVars)}\n\nReply with a number: ${stars} ⭐`;
          }

          const score = parseInt(input.trim());
          if (isNaN(score) || score < 1 || score > maxStars) {
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
            return d.validationError || `Please reply with a number from *1* to *${maxStars}*.`;
          }

          const isPositive = d.ratingPositiveThreshold !== undefined && score >= d.ratingPositiveThreshold;
          flowData.flowVars = safeSetVar(
            safeSetVar(flowData.flowVars, d.variableName, String(score)),
            `${d.variableName}_isPositive`,
            isPositive ? "yes" : "no",
          );
          delete flowData.waitingFor;

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) {
            await resetSession(guestId, hotelId);
            let reply = `Thank you for your *${score}★* rating! 🌟`;
            if (isPositive && d.reviewUrl) reply += `\n\nWe'd love your review: ${d.reviewUrl}`;
            return reply;
          }

          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          const rest = await advance(next);

          // Prepend the review link if positive rating
          if (isPositive && d.reviewUrl) {
            const reviewMsg = `Thank you for your *${score}★* rating! 🌟\n\nWe'd love your review: ${d.reviewUrl}`;
            return rest ? `${reviewMsg}\n\n${rest}` : reviewMsg;
          }
          return rest;
        }

        // ── text (default) ─────────────────────────────────────────────────────
        if (!flowData.waitingFor) {
          flowData.waitingFor = "answer";
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
          return interpolate(d.text || "Please reply.", flowData.flowVars);
        }

        // Validate text input
        const rule = d.validation ?? "none";
        if (rule === "number"  && (isNaN(parseFloat(input)) || input.trim() === "")) {
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
          return d.validationError || "Please provide a valid number.";
        }
        if (rule === "email"   && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) {
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
          return d.validationError || "Please provide a valid email address.";
        }
        if (rule === "date"    && !(await parseGuestDate(input))) {
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
          return d.validationError || "Please provide a valid date.";
        }

        flowData.flowVars = safeSetVar(flowData.flowVars, d.variableName, input);
        // Canonical aliases — safeSetVar blocks reserved keys like "guestName" to prevent
        // arbitrary guest injection, but the aliases below are intentional runtime cross-refs.
        if (d.variableName) {
          const key = d.variableName.toLowerCase();
          if (key.includes("name")) {
            flowData.flowVars["bookingGuestName"] ??= input;
            // Populate guestName when blank so {{guestName}} works in downstream messages.
            // guest?.name from the DB is commonly empty for WhatsApp contacts, making the
            // flow-collected answer the only reliable source for the guest's display name.
            if (!flowData.flowVars["guestName"]) flowData.flowVars["guestName"] = input;
          }
          if (key.includes("checkin"))  flowData.flowVars["bookingCheckIn"]  ??= input;
          if (key.includes("checkout")) flowData.flowVars["bookingCheckOut"] ??= input;
        }
        delete flowData.waitingFor;

        const next = nextNodeId(currentNodeId, adjacency);
        if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── check_availability ───────────────────────────────────────────────────
      case "check_availability": {
        const d    = node.data as CheckAvailabilityNodeData;
        const vars = flowData.flowVars;

        const roomTypeId = vars[d.roomTypeIdVar] ?? null;
        const checkIn    = vars[d.checkInVar]    ?? null;
        const checkOut   = vars[d.checkOutVar]   ?? null;

        let available = false;
        let availableCount = 0;

        if (!roomTypeId || !checkIn || !checkOut) {
          log.error(
            { flowId, nodeId: currentNodeId, hotelId, roomTypeIdVar: d.roomTypeIdVar, checkInVar: d.checkInVar, checkOutVar: d.checkOutVar },
            "check_availability: one or more required variables are missing — check node configuration"
          );
          flowData.flowVars = {
            ...flowData.flowVars,
            __flowError__: `check_availability misconfigured — roomTypeId=${roomTypeId ?? "missing"}, checkIn=${checkIn ?? "missing"}, checkOut=${checkOut ?? "missing"}`,
          };
        } else {
          // Normalize dates to YYYY-MM-DD — guest input may be DD/MM/YYYY
          const checkInParsed  = parseFlexDate(checkIn);
          const checkOutParsed = parseFlexDate(checkOut);
          if (checkInParsed && checkOutParsed && checkOutParsed > checkInParsed) {
            try {
              const result = await withActionTimeout(checkRoomAvailability(
                hotelId, roomTypeId,
                toDateStr(checkInParsed),
                toDateStr(checkOutParsed)
              ));
              available      = result.available;
              availableCount = result.availableCount;
            } catch (err: any) {
              if (err.message === "Action timeout") {
                log.error({ flowId, nodeId: currentNodeId, hotelId }, "check_availability: timed out");
                flowData.flowVars = { ...flowData.flowVars, __flowError__: "Action timed out. Please try again." };
              } else {
                throw err;
              }
            }
          } else if (!checkInParsed || !checkOutParsed) {
            log.warn({ flowId, checkIn, checkOut }, "check_availability: invalid date strings");
          }
        }

        // Store result for use in downstream nodes
        flowData.flowVars = {
          ...flowData.flowVars,
          availabilityResult:      available ? "available" : "unavailable",
          availabilityCount:       String(availableCount),
        };

        const handle   = available ? "available" : "unavailable";
        const fallback = nextNodeId(currentNodeId, adjacency);
        const next     = nextNodeId(currentNodeId, adjacency, handle) ?? fallback;

        if (!next) {
          await resetSession(guestId, hotelId);
          return available ? null : (d.unavailableMessage || "Sorry, that room is not available for those dates. Please try different dates or contact us.");
        }

        if (!available && d.unavailableMessage) {
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          const rest = await advance(next);
          return rest ? `${d.unavailableMessage}\n\n${rest}` : d.unavailableMessage;
        }

        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── show_rooms ───────────────────────────────────────────────────────────
      case "show_rooms": {
        const d    = node.data as ShowRoomsNodeData;
        const vars = flowData.flowVars;

        if (!flowData.waitingFor) {
          // Phase 1: fetch rooms and show list
          let allRooms = await fetchRoomTypes(hotelId, {
            ...(d.minCapacity ? { minCapacity: d.minCapacity } : {}),
            ...(d.minAdults   ? { minAdults:   d.minAdults   } : {}),
            ...(d.minChildren ? { minChildren: d.minChildren } : {}),
          });

          type RoomEntry = typeof allRooms[number] & { availableCount?: number };
          let displayRooms: RoomEntry[] = allRooms;

          if (d.filter === "available_only") {
            const checkIn  = d.checkInVar  ? vars[d.checkInVar]  : null;
            const checkOut = d.checkOutVar ? vars[d.checkOutVar] : null;

            if (checkIn && checkOut) {
              // Single bulk query instead of N×3 per-room queries
              const calendar = await getCalendarData(hotelId, checkIn, checkOut);
              displayRooms = allRooms
                .map((r) => {
                  const dates = calendar.dates;
                  let minAvail = Infinity;
                  for (const ds of dates) {
                    const cell = calendar.cells[r.id]?.[ds];
                    const avail = cell?.availableRooms ?? 0;
                    if (avail < minAvail) minAvail = avail;
                  }
                  const availableCount = minAvail === Infinity ? 0 : minAvail;
                  return { ...r, availableCount, available: availableCount > 0 };
                })
                .filter((r) => r.available);
            }
          }

          if (!displayRooms.length) {
            await resetSession(guestId, hotelId);
            return d.validationError
              || "Sorry, there are no rooms available for those dates. Please try different dates or contact us directly.";
          }

          const prompt   = interpolate(d.text || "Please choose a room type:", vars);
          const listText = buildRoomListText(prompt, displayRooms);

          flowData.waitingFor = "answer";
          flowData.flowVars   = {
            ...vars,
            __roomList__: JSON.stringify(
              displayRooms.map((r) => ({
                id:          r.id,
                name:        r.name,
                price:       r.basePrice,
                maxAdults:   r.maxAdults  ?? null,
                maxChildren: r.maxChildren ?? null,
              }))
            ),
          };

          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });

          // Try carousel send (visual scrollable room cards). Falls back to the
          // text list if WhatsApp credentials are absent or Meta rejects the send.
          const carouselSent = await trySendRoomCarousel({
            hotelId,
            guestId,
            displayRooms: displayRooms.slice(0, 10),
            promptText:   prompt,
          });
          // "ALREADY_SENT" sentinel — the carousel was dispatched to Meta
          // directly, so the upstream pipeline must NOT also send a text reply.
          // Distinct from `null` ("bot has nothing to say"); see message.service.ts
          // for the NIGHT-mode handling that depends on this distinction.
          if (carouselSent) return "ALREADY_SENT";

          return listText;
        }

        // Phase 2: validate selection
        let rawList: { id: string; name: string; price: number; maxAdults: number | null; maxChildren: number | null }[] = [];
        try { rawList = JSON.parse(flowData.flowVars["__roomList__"] ?? "[]"); } catch { /* corrupted — treat as empty */ }

        if (!rawList.length) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }

        // ── View Photos handler ───────────────────────────────────────────────
        // Carousel "View Photos" buttons emit "photos_<roomId>". Send extra
        // photos then re-render the carousel so the guest can still select.
        const photosIdMatch = input.match(/^photos_(.+)$/);
        if (photosIdMatch) {
          const roomId = photosIdMatch[1]!;

          const [roomType, guest] = await Promise.all([
            prisma.roomType.findFirst({
              where:   { id: roomId, hotelId },
              include: { photos: { orderBy: { order: "asc" } } },
            }),
            prisma.guest.findUnique({ where: { id: guestId }, select: { phone: true } }),
          ]);

          // Keep session at this node — guest still needs to pick a room
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });

          // Skip index 0 (shown as the carousel header image); send up to 5 more
          const extraPhotos = (roomType?.photos ?? []).slice(1, 6);

          if (!roomType || extraPhotos.length === 0 || !guest) {
            return "No additional photos available for this room.";
          }

          for (const photo of extraPhotos) {
            try {
              await sendMediaMessage({
                toPhone:     guest.phone,
                hotelId,
                messageType: "image",
                mediaUrl:    photo.url,
                mimeType:    "image/jpeg",
                caption:     null,
              });
            } catch (err) {
              log.warn({ err, roomId, url: photo.url }, "show_rooms: photo send failed");
            }
          }

          // Re-send carousel so guest can still select a room.
          // Re-fetch rooms with full data (description, carouselButtonLabel) using
          // the stored ID order from __roomList__.
          let repromptIds: string[] = [];
          try {
            const stored: { id: string }[] = JSON.parse(flowData.flowVars["__roomList__"] ?? "[]");
            repromptIds = stored.map((r) => r.id);
          } catch { /* ignore */ }

          if (repromptIds.length >= 2) {
            const fullRooms = await prisma.roomType.findMany({
              where:   { id: { in: repromptIds }, hotelId },
              select:  { id: true, name: true, basePrice: true, description: true, carouselButtonLabel: true },
            });
            const byId = new Map(fullRooms.map((r) => [r.id, r]));
            const orderedRooms = repromptIds
              .map((id) => byId.get(id))
              .filter((r): r is NonNullable<typeof r> => r !== undefined);

            if (orderedRooms.length >= 2) {
              await trySendRoomCarousel({
                hotelId,
                guestId,
                displayRooms: orderedRooms.slice(0, 10),
                promptText:   interpolate(d.text || "Please choose a room type:", flowData.flowVars),
              });
            }
          }

          return "ALREADY_SENT";
        }

        // Resolve the selected room. Carousel button replies come in as
        // "room_<roomId>" (synthesised in the webhook handler from
        // interactive.button_reply.id); text-list replies come in as 1..N.
        let chosen: typeof rawList[number] | undefined;
        const roomIdMatch = input.match(/^room_(.+)$/);
        if (roomIdMatch) {
          chosen = rawList.find((r) => r.id === roomIdMatch[1]);
        } else {
          const num = parseInt(input, 10);
          if (!isNaN(num) && num >= 1 && num <= rawList.length) {
            const candidate = rawList[num - 1];
            if (candidate !== undefined) chosen = candidate;
          }
        }

        if (!chosen) {
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
          return d.validationError || `Please reply with a number between *1* and *${rawList.length}*.`;
        }
        const prefix  = d.variableName || "room";
        const dotBase = d.variableName || "selectedRoom";
        flowData.flowVars = {
          ...flowData.flowVars,
          [`${prefix}TypeId`]:      chosen.id,
          [`${prefix}TypeName`]:    chosen.name,
          [`${prefix}Price`]:       String(chosen.price),
          ...(chosen.maxAdults   != null ? { [`${prefix}MaxAdults`]:   String(chosen.maxAdults)   } : {}),
          ...(chosen.maxChildren != null ? { [`${prefix}MaxChildren`]: String(chosen.maxChildren) } : {}),
          // canonical booking aliases
          bookingRoomTypeId:    chosen.id,
          bookingRoomTypeName:  chosen.name,
          bookingPricePerNight: String(chosen.price),
          // dot-notation vars: {{selectedRoom.name}}, {{selectedRoom.price}}, etc.
          [`${dotBase}.id`]:    chosen.id,
          [`${dotBase}.name`]:  chosen.name,
          [`${dotBase}.price`]: String(chosen.price),
          ...(chosen.maxAdults   != null ? { [`${dotBase}.maxAdults`]:   String(chosen.maxAdults)   } : {}),
          ...(chosen.maxChildren != null ? { [`${dotBase}.maxChildren`]: String(chosen.maxChildren) } : {}),
        };
        delete flowData.waitingFor;

        const next = nextNodeId(currentNodeId, adjacency);
        if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── branch ───────────────────────────────────────────────────────────────
      case "branch": {
        const d = node.data as BranchNodeData;
        let handle = d.defaultHandleId;

        for (const cond of d.conditions) {
          if (evaluateCondition(cond, flowData.flowVars)) {
            handle = cond.id;
            break;
          }
        }

        const next =
          nextNodeId(currentNodeId, adjacency, handle) ??
          nextNodeId(currentNodeId, adjacency, d.defaultHandleId) ??
          nextNodeId(currentNodeId, adjacency);

        if (!next) {
          log.error({ flowId, nodeId: currentNodeId, handle }, "branch node has no outgoing edge");
          await resetSession(guestId, hotelId);
          return safeMenu(hotelId);
        }
        return advance(next);
      }

      // ── action ───────────────────────────────────────────────────────────────
      case "action": {
        const d = node.data as ActionNodeData;

        // ── create_booking ─────────────────────────────────────────────────────
        if (d.actionType === "create_booking") {
          const vars = flowData.flowVars;

          const guestName  = (d.guestNameVar  && vars[d.guestNameVar])  || vars["bookingGuestName"]  || null;
          const roomTypeId = (d.roomTypeIdVar && vars[d.roomTypeIdVar]) || vars["bookingRoomTypeId"] || null;
          const checkIn    = (d.checkInVar    && vars[d.checkInVar])    || vars["bookingCheckIn"]    || null;
          const checkOut   = (d.checkOutVar   && vars[d.checkOutVar])   || vars["bookingCheckOut"]   || null;
          const advancePaidRaw = d.advancePaidVar ? vars[d.advancePaidVar] : null;

          if (!guestName || !roomTypeId || !checkIn || !checkOut) {
            const next = nextNodeId(currentNodeId, adjacency);
            const errMsg = "⚠️ Could not create booking — missing required details. Please contact us directly.";
            if (!next) { await resetSession(guestId, hotelId); return errMsg; }
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
            return advance(next);
          }

          const checkInDate  = parseFlexDate(checkIn);
          const checkOutDate = parseFlexDate(checkOut);

          if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
            const next = nextNodeId(currentNodeId, adjacency);
            const errMsg = "⚠️ Booking failed — invalid or reversed dates. Please contact us directly.";
            if (!next) { await resetSession(guestId, hotelId); return errMsg; }
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
            return advance(next);
          }

          const config = await prisma.hotelConfig.findUnique({
            where: { hotelId },
            select: { bookingEnabled: true, availabilityEnabled: true },
          });

          if (config && !config.bookingEnabled) {
            const errMsg = "⚠️ Online booking is currently unavailable. Please contact us directly to make a reservation.";
            const next = nextNodeId(currentNodeId, adjacency);
            if (!next) { await resetSession(guestId, hotelId); return errMsg; }
            await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
            return advance(next);
          }

          if (config?.availabilityEnabled) {
            const { available } = await checkRoomAvailability(
              hotelId, roomTypeId,
              toDateStr(checkInDate),
              toDateStr(checkOutDate)
            );
            if (!available) {
              await resetSession(guestId, hotelId);
              return "❌ Sorry, that room type is fully booked for the selected dates. Please contact us to check alternatives.";
            }
          }

          const roomType    = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
          const pricePerNight = roomType ? roomType.basePrice : 0;
          const nights        = Math.max(1, Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000));
          const totalPrice    = pricePerNight * nights;
          const advancePaid   = advancePaidRaw ? Math.round(parseFloat(advancePaidRaw)) : 0;
          const lockKey = `${hotelId}:${new Date().getFullYear()}`;

          let booking: Awaited<ReturnType<typeof prisma.booking.create>>;
          try {
            booking = await withActionTimeout(prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
              const referenceNumber = await generateReferenceNumber(tx);
              return tx.booking.create({
                data: {
                  hotelId, guestId, roomTypeId, guestName,
                  checkIn: checkInDate, checkOut: checkOutDate,
                  status: BookingStatus.PENDING, pricePerNight, totalPrice, advancePaid,
                  referenceNumber,
                },
              });
            }));
          } catch (err: any) {
            if (err.message === "Action timeout") {
              log.error({ flowId, nodeId: currentNodeId, hotelId, guestId }, "create_booking: transaction timed out");
              flowData.flowVars = { ...flowData.flowVars, __flowError__: "Action timed out. Please try again." };
              const next = nextNodeId(currentNodeId, adjacency);
              const msg  = "⏱ Booking request timed out. Please try again.";
              if (!next) { await resetSession(guestId, hotelId); return msg; }
              await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
              return advance(next);
            }
            throw err;
          }

          flowData.flowVars = {
            ...flowData.flowVars,
            bookingRef:    booking.referenceNumber ?? booking.id.slice(0, 8).toUpperCase(),
            bookingStatus: BookingStatus.PENDING,
            bookingId:     booking.id,
          };

          // TODO: Booking confirmation should be triggered explicitly
          // via a Send Template node in the flow builder, not auto-sent here.

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) {
            await resetSession(guestId, hotelId);
            return d.message
              ? interpolate(d.message, flowData.flowVars)
              : `✅ Booking confirmed! Your reference: *${flowData.flowVars["bookingRef"]}*`;
          }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── update_booking_status ──────────────────────────────────────────────
        if (d.actionType === "update_booking_status") {
          if (d.newStatus) {
            // Prefer full bookingId; fall back to bookingRef (8-char prefix) for legacy
            const fullId = d.bookingRefVar
              ? flowData.flowVars[d.bookingRefVar]
              : (flowData.flowVars["bookingId"] ?? flowData.flowVars["bookingRef"]);

            if (fullId) {
              // Try exact full UUID first, then prefix match for 8-char bookingRef
              let booking = await prisma.booking.findFirst({ where: { hotelId, id: fullId } });
              if (!booking && fullId.length <= 8) {
                booking = await prisma.booking.findFirst({
                  where: { hotelId, id: { startsWith: fullId.toLowerCase() } },
                });
              }
              if (booking) {
                await prisma.booking.update({ where: { id: booking.id }, data: { status: d.newStatus } });
                flowData.flowVars = { ...flowData.flowVars, bookingStatus: d.newStatus };
              }
            }
          }

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) {
            await resetSession(guestId, hotelId);
            return d.message ? interpolate(d.message, flowData.flowVars) : null;
          }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── set_variable ───────────────────────────────────────────────────────
        if (d.actionType === "set_variable") {
          if (d.variableToSet && d.valueToSet !== undefined) {
            flowData.flowVars = {
              ...flowData.flowVars,
              [d.variableToSet]: interpolate(d.valueToSet, flowData.flowVars),
            };
          }
          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return null; }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // ── send_review_request ────────────────────────────────────────────────
        if (d.actionType === "send_review_request") {
          let reviewUrl = d.reviewUrl?.trim() || null;
          if (!reviewUrl) {
            const cfg = await prisma.hotelConfig.findUnique({ where: { hotelId } });
            reviewUrl = (cfg as any)?.reviewUrl ?? null;
          }
          const bodyText = d.reviewMessage
            ? interpolate(d.reviewMessage, flowData.flowVars)
            : "We'd love to hear about your experience! Please take a moment to leave us a review.";

          const fullMsg = reviewUrl ? `${bodyText}\n\n${reviewUrl}` : bodyText;

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) {
            await resetSession(guestId, hotelId);
            return fullMsg;
          }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          const rest = await advance(next);
          return rest ? `${fullMsg}\n\n${rest}` : fullMsg;
        }

        // ── notify_staff ───────────────────────────────────────────────────────
        if (d.actionType === "notify_staff") {
            
          // Browser notification to staff
        const guest = await prisma.guest.findUnique({ 
          where: { id: guestId }, 
          select: { name: true, phone: true } 
        });
        const { emitToHotel } = await import("../realtime/emit");
        emitToHotel(hotelId, "staff:notification", {
          guestId,
          guestName: guest?.name || flowData.flowVars["guestName"] || guest?.phone || "A guest",
          timestamp: new Date().toISOString(),
        });
        log.info({ hotelId }, "notify_staff emitted");
        flowData.flowVars = { ...flowData.flowVars, staffNotified: "yes" };
        const next = nextNodeId(currentNodeId, adjacency);
        if (!next) {
          await resetSession(guestId, hotelId);
        return d.message
        ? interpolate(d.message, flowData.flowVars)
        : "Our team has been notified and will be in touch shortly.";
        }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        const rest = await advance(next);
        if (d.message) {
          const note = interpolate(d.message, flowData.flowVars);
          return rest ? `${note}\n\n${rest}` : note;
        }
        return rest;
        }

        // ── start_booking_flow (removed — booking state machine is gone) ──────────
        // Use the "create_booking" action node with a show_rooms + question nodes instead.
        if (d.actionType === "start_booking_flow") {
          log.error({ flowId }, 'deprecated action "start_booking_flow" — replace with create_booking');
          await resetSession(guestId, hotelId);
          return (d.message ? `${d.message}\n\n` : "") + (await safeMenu(hotelId) ?? "");
        }

        // ── handoff_to_staff ───────────────────────────────────────────────────
        if (d.actionType === "handoff_to_staff") {
          await updateSession(guestId, hotelId, "ENQUIRY_OPEN", {});
          return (
            (d.message || "Our team will assist you shortly. Please share your query and we'll respond as soon as possible.") +
            "\n\n_Reply *MENU* at any time to return to the main menu._"
          );
        }

        // ── reset_to_menu ──────────────────────────────────────────────────────
        if (d.actionType === "reset_to_menu") {
          await resetSession(guestId, hotelId);
          const menu = await safeMenu(hotelId);
          return d.message ? `${d.message}\n\n${menu ?? ""}`.trim() : menu;
        }

        // ── view_bookings ──────────────────────────────────────────────────────
        if (d.actionType === "view_bookings") {
          const bookings = await prisma.booking.findMany({
            where:   { guestId, hotelId },
            orderBy: { createdAt: "desc" },
            select: {
              referenceNumber: true,
              roomType:        { select: { name: true } },
              checkIn:         true,
              checkOut:        true,
              status:          true,
            },
          });

          let reply: string;
          if (!bookings.length) {
            reply = "You have no bookings with us yet.\n\n_Reply *MENU* to see all options._";
          } else {
            const STATUS_EMOJI: Record<string, string> = {
              CONFIRMED: "✅",
              PENDING:   "⏳",
              CANCELLED: "❌",
              COMPLETED: "🏁",
            };
            const lines = bookings.map((b) => {
              const emoji    = STATUS_EMOJI[b.status] ?? "📋";
              const checkIn  = new Date(b.checkIn).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
              const checkOut = new Date(b.checkOut).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
              return `📋 *${b.referenceNumber ?? b.status}*\nRoom: ${b.roomType?.name ?? "N/A"}\nCheck-in: ${checkIn} · Check-out: ${checkOut}\nStatus: ${b.status} ${emoji}`;
            });
            reply = `*Your Bookings*\n\n${lines.join("\n\n")}\n\n_Reply *MENU* to return to the main menu._`;
          }

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) {
            await resetSession(guestId, hotelId);
            return reply;
          }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          const rest = await advance(next);
          return rest ? `${reply}\n\n${rest}` : reply;
        }

        // ── cancel_booking ─────────────────────────────────────────────────────
        if (d.actionType === "cancel_booking") {
          const bookingId = d.bookingRefVar
            ? flowData.flowVars[d.bookingRefVar]
            : flowData.flowVars["bookingId"] ?? flowData.flowVars["bookingRef"];

          if (!bookingId) {
            log.error({ flowId, nodeId: currentNodeId, hotelId, guestId }, "cancel_booking: no bookingId in flowVars");
            flowData.flowVars = { ...flowData.flowVars, __flowError__: "No booking found to cancel." };
          } else {
            try {
              await withActionTimeout(cancelBooking(bookingId, hotelId));
              flowData.flowVars = { ...flowData.flowVars, __cancelSuccess__: "true" };
            } catch (err: any) {
              const msg = err.message === "Action timeout"
                ? "Request timed out. Please try again."
                : (err.message ?? "Could not cancel booking.");
              log.error({ flowId, nodeId: currentNodeId, hotelId, guestId, err }, "cancel_booking failed");
              flowData.flowVars = { ...flowData.flowVars, __flowError__: msg };
            }
          }

          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return null; }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // Unknown action — advance silently
        const next = nextNodeId(currentNodeId, adjacency);
        if (!next) { await resetSession(guestId, hotelId); return null; }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── end ──────────────────────────────────────────────────────────────────
      case "end": {
        const d = node.data as EndNodeData;
        await resetSession(guestId, hotelId);
        const text = d.farewellText?.trim();
        return text ? interpolate(text, flowData.flowVars) : null;
      }

      // ── time_condition ───────────────────────────────────────────────────────
      // Reads the hotel's businessStartHour / businessEndHour + timezone from
      // HotelConfig and routes to: "business_hours" | "after_hours" | "weekend"
      case "time_condition": {
        const cfg = await prisma.hotelConfig.findUnique({
          where:  { hotelId },
          select: { businessStartHour: true, businessEndHour: true, timezone: true },
        });

        const tz       = cfg?.timezone ?? "UTC";
        const now      = new Date();
        const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const day      = nowLocal.getDay();   // 0=Sun,6=Sat
        const hour     = nowLocal.getHours();

        let handle: string;
        if (day === 0 || day === 6) {
          handle = "weekend";
        } else if (
          hour >= (cfg?.businessStartHour ?? 9) &&
          hour <  (cfg?.businessEndHour   ?? 21)
        ) {
          handle = "business_hours";
        } else {
          handle = "after_hours";
        }

        // Fall back to any outgoing edge if the exact handle has no edge
        const next =
          nextNodeId(currentNodeId, adjacency, handle) ??
          nextNodeId(currentNodeId, adjacency);

        if (!next) { await resetSession(guestId, hotelId); return safeMenu(hotelId); }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── jump ─────────────────────────────────────────────────────────────────
      // Teleports execution to another node — useful for sub-menu loops.
      case "jump": {
        const d = node.data as JumpNodeData;
        if (!d.targetNodeId || !nodeMap.has(d.targetNodeId)) {
          log.error({ flowId, targetNodeId: d.targetNodeId }, "jump node references missing targetNodeId");
          await resetSession(guestId, hotelId);
          return safeMenu(hotelId);
        }
        await updateSession(guestId, hotelId, `FLOW:${flowId}:${d.targetNodeId}`, { ...sessionData, flow: { ...flowData } });
        return advance(d.targetNodeId);
      }

      // ── send_template ────────────────────────────────────────────────────────
      // Sends an approved WhatsApp template to the guest.
      // Each {{n}} variable resolved from flowVars via variableMapping.
      // Routes: "success" handle → next node; "failure" handle → fallback.
      case "send_template": {
        const { sendTemplateMessage } = await import("../services/templates.service");
        const d = node.data as any;

        const template = d.templateId
          ? await prisma.whatsAppTemplate.findFirst({
              where: { id: d.templateId, hotelId, status: "APPROVED" },
            })
          : null;

        if (!template) {
          log.warn({ flowId, nodeId: currentNodeId, templateId: d.templateId }, "send_template: template not found or not approved");
          const failNext = nextNodeId(currentNodeId, adjacency, "failure") ?? nextNodeId(currentNodeId, adjacency);
          if (!failNext) { await resetSession(guestId, hotelId); return (d.failureMessage as string | undefined) || null; }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${failNext}`, { ...sessionData, flow: { ...flowData } });
          return advance(failNext);
        }

        const components = template.components as { body?: { text?: string } };
        const bodyText   = components?.body?.text ?? "";
        const tplVarRe   = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
        const tplVarIds: string[] = [];
        const tplSeen = new Set<string>();
        let tm: RegExpExecArray | null;
        while ((tm = tplVarRe.exec(bodyText)) !== null) {
          const id = tm[1]!;
          if (!tplSeen.has(id)) { tplSeen.add(id); tplVarIds.push(id); }
        }
        const vm = ((d.variableMapping ?? {}) as Record<string, string>);

        const values: Record<string, string> = {};
        for (const id of tplVarIds) {
          const flowVarName = vm[id] ?? "";
          values[id] = flowVarName
            ? (flowData.flowVars[flowVarName] ?? interpolate(flowVarName, flowData.flowVars))
            : "";
        }

        let sendOk = false;
        try {
          await sendTemplateMessage(hotelId, guestId, d.templateId, values);
          sendOk = true;
        } catch (err: unknown) {
          log.warn({ err, templateId: d.templateId, flowId }, "send_template node: failed to send template");
        }

        const handle  = sendOk ? "success" : "failure";
        const next    = nextNodeId(currentNodeId, adjacency, handle) ?? nextNodeId(currentNodeId, adjacency);

        if (!next) {
          await resetSession(guestId, hotelId);
          return sendOk ? null : ((d.failureMessage as string | undefined) || null);
        }

        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        return advance(next);
      }

      // ── send_saved_reply ─────────────────────────────────────────────────────
      // Fetches an internal SavedReply by id, resolves {{var}} placeholders from
      // flowVars + per-node variableOverrides, then sends the resolved text.
      case "send_saved_reply": {
        const d = node.data as any;
        const savedReply = d.savedReplyId
          ? await prisma.savedReply.findFirst({ where: { id: d.savedReplyId, hotelId } })
          : null;

        if (!savedReply) {
          log.warn({ flowId, nodeId: currentNodeId, savedReplyId: d.savedReplyId }, "send_saved_reply: reply not found");
          const next = nextNodeId(currentNodeId, adjacency);
          if (!next) { await resetSession(guestId, hotelId); return null; }
          await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
          return advance(next);
        }

        // Merge flowVars with per-node overrides (overrides take priority)
        const overrides = (d.variableOverrides ?? {}) as Record<string, string>;
        const mergedVars: Record<string, string> = { ...flowData.flowVars };
        for (const [k, v] of Object.entries(overrides)) {
          if (v) mergedVars[k] = interpolate(v, flowData.flowVars);
        }

        const text = interpolate(savedReply.body, mergedVars);
        const next = nextNodeId(currentNodeId, adjacency);

        if (!next) {
          await resetSession(guestId, hotelId);
          return text;
        }

        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        const rest = await advance(next);
        if (!rest) return text;
        return `${text}\n\n${rest}`;
      }

      // ── show_menu ─────────────────────────────────────────────────────────────
      // Emits the hotel's formatted WhatsApp menu text (same as buildMenuMessage).
      // Continues to the next node after emitting — use an end node to terminate.
      case "show_menu": {
        const menuText = await buildMenuMessage(hotelId);
        const next     = nextNodeId(currentNodeId, adjacency);

        if (!next) {
          await resetSession(guestId, hotelId);
          return menuText ?? MENU_FALLBACK;
        }

        await updateSession(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
        const rest = await advance(next);
        if (!menuText) return rest;
        if (!rest)     return menuText;
        return `${menuText}\n\n${rest}`;
      }

      // ── delay ─────────────────────────────────────────────────────────────────
      // Pauses flow execution for a configurable duration. Saves a PausedFlow
      // record + enqueues a BullMQ job on 'flow-resume'. The session is reset to
      // IDLE so the guest can still interact with the menu during the pause.
      case "delay": {
        const d = node.data as DelayNodeData;

        const durationMs =
          d.unit === "minutes" ? (d.duration ?? 1) * 60_000 :
          d.unit === "hours"   ? (d.duration ?? 1) * 3_600_000 :
                                 (d.duration ?? 1) * 86_400_000; // days

        const resumeAt    = new Date(Date.now() + durationMs);
        const resumeNodeId = nextNodeId(currentNodeId, adjacency);

        if (!resumeNodeId) {
          // No output edge — treat the delay as a terminal node
          await resetSession(guestId, hotelId);
          const msg = d.resumeMessage ? interpolate(d.resumeMessage, flowData.flowVars) : null;
          return msg;
        }

        // Persist pause context so the worker can restore execution
        const paused = await prisma.pausedFlow.create({
          data: {
            hotelId,
            guestId,
            flowId,
            nodeId:   resumeNodeId,
            flowVars: flowData.flowVars,
            resumeAt,
          },
        });

        // jobId deduplicates: if the guest triggers the same flow again before
        // the timer fires, BullMQ silently discards the duplicate enqueue.
        const jobIdStr = `flow-resume:${guestId}:${flowId}`;
        const job = await flowResumeQueue.add(
          "resume",
          { pausedFlowId: paused.id },
          { delay: durationMs, jobId: jobIdStr },
        );

        // Store the actual BullMQ job id for potential future cancellation
        await prisma.pausedFlow.update({
          where: { id: paused.id },
          data:  { jobId: job.id ?? null },
        });

        // Park the session so mid-pause messages don't re-enter the flow
        await resetSession(guestId, hotelId);

        return d.resumeMessage ? interpolate(d.resumeMessage, flowData.flowVars) : null;
      }

      default: {
        await resetSession(guestId, hotelId);
        return safeMenu(hotelId);
      }
    }
  }
}
