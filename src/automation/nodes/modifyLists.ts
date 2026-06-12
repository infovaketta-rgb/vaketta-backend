/**
 * modifyLists.ts
 *
 * Injectable WhatsApp interactive-LIST senders for the advanced_room_allocation
 * node's Phase 2 (manual-mode) sub-phases. Three senders, each returning true
 * when the list was dispatched ("ALREADY_SENT") so the caller skips the plain-
 * text fallback, or false / throwing (→ catch returns false) so the caller
 * renders the text alternative.
 *
 * All three follow the same pattern as trySendMixItUpList in flowRuntime.ts and
 * trySendPlanList in planList.ts — DB lookup, credential decrypt, sendListMessage,
 * prisma.message.create, socket emit.
 *
 * Pure builder functions are exported for unit testing.
 */

import prisma from "../../db/connect";
import { sendListMessage } from "../../services/whatsapp.send.service";
import { decryptWhatsAppToken } from "../../utils/encryption.utils";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import type {
  AllocationRoom,
  AllocationRoomInput,
  AraState,
  RoomConfigResolver,
} from "./advancedRoomAllocation";

const log = logger.child({ service: "modify-lists" });

// Row-description hard limit imposed by Meta.
const ROW_DESC_MAX = 72;

// ── Row-id constants ──────────────────────────────────────────────────────────

export const MOD_REMOVE_EXTRA_BED = "MOD_REMOVE_EXTRA_BED";
export const MOD_ADD_EXTRA_BED    = "MOD_ADD_EXTRA_BED";
export const MOD_MOVE_GUEST_OUT   = "MOD_MOVE_GUEST_OUT";
export const MOD_CHANGE_ROOM_TYPE = "MOD_CHANGE_ROOM_TYPE";
export const MOD_REMOVE_ROOM      = "MOD_REMOVE_ROOM";
export const MOD_GO_BACK          = "MOD_GO_BACK";
export const MOVE_GO_BACK         = "MOVE_GO_BACK";
export const MODIFY_DONE          = "MODIFY_DONE";
export const MODIFY_GO_BACK       = "MODIFY_GO_BACK";

/** Prefix for per-slot destination rows in the move-to-room list. */
export const MOVE_TO_ROOM_PREFIX = "MOVE_TO_ROOM_";

/** Prefix for edit-existing rows in the manual-mode overview list. */
export const EDIT_ROOM_PREFIX = "EDIT_ROOM_";

/** Prefix for add-a-room rows in the manual-mode overview list. */
export const ADD_ROOM_PREFIX = "ADD_ROOM_";

// ── Pure builders (exported for tests) ───────────────────────────────────────

export type RoomAction = "add_bed" | "remove_bed" | "move_guest" | "change_type" | "remove_room";

const ACTION_LABELS: Record<RoomAction, string> = {
  add_bed:     "Add extra bed",
  remove_bed:  "Remove extra bed",
  move_guest:  "Move a guest out",
  change_type: "Change room type",
  remove_room: "Remove this room",
};

const ACTION_IDS: Record<RoomAction, string> = {
  add_bed:     MOD_ADD_EXTRA_BED,
  remove_bed:  MOD_REMOVE_EXTRA_BED,
  move_guest:  MOD_MOVE_GUEST_OUT,
  change_type: MOD_CHANGE_ROOM_TYPE,
  remove_room: MOD_REMOVE_ROOM,
};

/**
 * Build the sections for the room-menu list message.
 * options is the same array returned by roomMenuOptions() — preserving order.
 */
export function buildRoomMenuSections(
  room:      AllocationRoom,
  options:   RoomAction[],
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const modRows = options.map((a) => ({
    id:          ACTION_IDS[a],
    title:       ACTION_LABELS[a].slice(0, 24),
  }));

  return [
    { title: "Modify Room", rows: modRows },
    { title: "Navigation",  rows: [{ id: MOD_GO_BACK, title: "↩️ Go back" }] },
  ];
}

/**
 * Build the sections for the move-to-room list message.
 * destIndices maps display position (1-based slot) → actual room array index,
 * matching how renderMoveToRoom builds its numbered list.
 */
export function buildMoveToRoomSections(
  state:      AraState,
  fromIndex:  number,
  pending:    { adults: number; children: number },
  resolveCfg: RoomConfigResolver,
): {
  sections: { title: string; rows: Array<{ id: string; title: string; description?: string }> }[];
  destIndices: number[];  // slot n (1-based) → state.selectedRooms[destIndices[n-1]]
} {
  const destIndices: number[] = [];
  const rows: Array<{ id: string; title: string; description?: string }> = [];

  state.selectedRooms.forEach((r, i) => {
    if (i === fromIndex) return;
    const slot = destIndices.length + 1;
    const cfg  = resolveCfg(r);
    destIndices.push(i);
    const desc = `Currently ${r.adults} adults, ${r.children} children (max ${cfg.maxAdults} adults, ${cfg.maxChildren} children)`.slice(0, ROW_DESC_MAX);
    rows.push({
      id:          `${MOVE_TO_ROOM_PREFIX}${slot}`,
      title:       r.roomTypeName.slice(0, 24),
      description: desc,
    });
  });

  const navRow = { id: MOVE_GO_BACK, title: "↩️ Go back" };

  return {
    sections: [
      { title: "Available Rooms", rows },
      { title: "Navigation",      rows: [navRow] },
    ],
    destIndices,
  };
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function occupancyLabel(r: AllocationRoom): string {
  return `${r.adults} adult${r.adults === 1 ? "" : "s"}, ${r.children} child${r.children === 1 ? "" : "ren"}`;
}

/**
 * Build the sections for the manual-mode overview list message.
 * Returns edit rows (1..N), add-room rows (N+1..N+M), and a Confirm section.
 */
export function buildManualModeSections(
  state:   AraState,
  addable: AllocationRoomInput[],
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const n = state.selectedRooms.length;

  const editRows = state.selectedRooms.map((r, i) => ({
    id:          `${EDIT_ROOM_PREFIX}${i + 1}`,
    title:       `Edit Room ${i + 1}: ${r.roomTypeName}`.slice(0, 24),
    description: `${occupancyLabel(r)} — ${inr(r.totalPrice)}`.slice(0, ROW_DESC_MAX),
  }));

  const addRows = addable.map((r, i) => ({
    id:          `${ADD_ROOM_PREFIX}${r.roomTypeId}`,
    title:       r.name.slice(0, 24),
    description: `Fits ${r.maxAdults ?? "?"} adults, ${r.maxChildren ?? "?"} children · ${inr(r.basePrice)}/night · ${r.availableCount} avail`.slice(0, ROW_DESC_MAX),
  }));

  const confirmRows = [
    { id: MODIFY_DONE,    title: "✅ Confirm booking" },
    { id: MODIFY_GO_BACK, title: "↩️ Go back" },
  ];

  const sections: { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] = [];

  if (editRows.length > 0)  sections.push({ title: "Edit Existing Rooms", rows: editRows });
  if (addRows.length  > 0)  sections.push({ title: "Add a Room",          rows: addRows  });
  sections.push({ title: "Confirm", rows: confirmRows });

  return sections;
}

// ── Shared DB/credential helper ───────────────────────────────────────────────

async function resolveHotelGuest(
  hotelId: string,
  guestId: string,
): Promise<{ phone: string; hotelPhone: string; phoneNumberId: string; accessToken: string } | null> {
  const [hotel, guest] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: hotelId }, include: { config: true } }),
    prisma.guest.findUnique({ where: { id: guestId } }),
  ]);
  if (!hotel || !guest) return null;
  const cfg           = hotel.config;
  const phoneNumberId = cfg?.metaPhoneNumberId ?? "";
  const encryptedTok  = cfg?.metaAccessTokenEncrypted ?? "";
  if (!phoneNumberId || !encryptedTok) return null;
  const accessToken = decryptWhatsAppToken(encryptedTok);
  return { phone: guest.phone, hotelPhone: hotel.phone, phoneNumberId, accessToken };
}

async function persistAndEmit(
  hotelId:   string,
  guestId:   string,
  fromPhone: string,
  toPhone:   string,
  wamid:     string,
  bodyText:  string,
  rows:      unknown[],
): Promise<void> {
  const saved = await prisma.message.create({
    data: {
      direction:   "OUT",
      fromPhone,
      toPhone,
      body:        JSON.stringify({ bodyText, rows }),
      messageType: "list",
      hotelId,
      guestId,
      channel:     MessageChannel.WHATSAPP,
      status:      MessageStatus.SENT,
      wamid,
    },
  });
  const { emitToHotel } = await import("../../realtime/emit");
  emitToHotel(hotelId, "message:new", { message: saved });
}

// ── Injectable sender 1: room-action menu ─────────────────────────────────────

export type SendRoomMenuListFn = (args: {
  hotelId:    string;
  guestId:    string;
  room:       AllocationRoom;
  options:    RoomAction[];
  roomIndex:  number;
}) => Promise<boolean>;

export async function trySendRoomMenuList(args: {
  hotelId:    string;
  guestId:    string;
  room:       AllocationRoom;
  options:    RoomAction[];
  roomIndex:  number;
}): Promise<boolean> {
  const { hotelId, guestId, room, options, roomIndex } = args;
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return false;
  try {
    const creds = await resolveHotelGuest(hotelId, guestId);
    if (!creds) return false;
    const { phone, hotelPhone, phoneNumberId, accessToken } = creds;

    const bodyText = `*Room ${roomIndex + 1}: ${room.roomTypeName}*\n👥 ${occupancyLabel(room)}\n💰 ${inr(room.pricePerNight)}/night\n\nWhat would you like to do?`;
    const sections = buildRoomMenuSections(room, options);
    const buttonLabel = "Options";
    const footerText  = "Type MENU to cancel";

    const allRows = sections.flatMap((s) => s.rows);

    const wamid = await sendListMessage(phone, phoneNumberId, accessToken, {
      bodyText,
      footerText,
      buttonLabel,
      sections,
    });

    await persistAndEmit(hotelId, guestId, hotelPhone, phone, wamid, bodyText, allRows);
    return true;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "room-menu list send failed — falling back to text");
    return false;
  }
}

// ── Injectable sender 2: move-to-room picker ─────────────────────────────────

export type SendMoveToRoomListFn = (args: {
  hotelId:     string;
  guestId:     string;
  state:       AraState;
  fromIndex:   number;
  pending:     { adults: number; children: number };
  resolveCfg:  RoomConfigResolver;
}) => Promise<{ sent: boolean; destIndices: number[] }>;

export async function trySendMoveToRoomList(args: {
  hotelId:    string;
  guestId:    string;
  state:      AraState;
  fromIndex:  number;
  pending:    { adults: number; children: number };
  resolveCfg: RoomConfigResolver;
}): Promise<{ sent: boolean; destIndices: number[] }> {
  const { hotelId, guestId, state, fromIndex, pending, resolveCfg } = args;
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return { sent: false, destIndices: [] };
  try {
    const creds = await resolveHotelGuest(hotelId, guestId);
    if (!creds) return { sent: false, destIndices: [] };
    const { phone, hotelPhone, phoneNumberId, accessToken } = creds;

    const { sections, destIndices } = buildMoveToRoomSections(state, fromIndex, pending, resolveCfg);
    if (destIndices.length === 0) return { sent: false, destIndices: [] };

    const moving: string[] = [];
    if (pending.adults   > 0) moving.push(`${pending.adults} adult${pending.adults === 1 ? "" : "s"}`);
    if (pending.children > 0) moving.push(`${pending.children} child${pending.children > 1 ? "ren" : ""}`);
    const bodyText    = `Move ${moving.join(", ")} to which room?`;
    const buttonLabel = "Choose Room";
    const footerText  = "Type MENU to cancel";

    const allRows = sections.flatMap((s) => s.rows);

    const wamid = await sendListMessage(phone, phoneNumberId, accessToken, {
      bodyText,
      footerText,
      buttonLabel,
      sections,
    });

    await persistAndEmit(hotelId, guestId, hotelPhone, phone, wamid, bodyText, allRows);
    return { sent: true, destIndices };
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "move-to-room list send failed — falling back to text");
    return { sent: false, destIndices: [] };
  }
}

// ── Injectable sender 4: change-room-type picker ─────────────────────────────

export const CHANGE_TYPE_GO_BACK   = "CHANGE_TYPE_GO_BACK";
/** Prefix for change-room-type rows — id = CHANGE_TYPE_{roomTypeId}. */
export const CHANGE_TYPE_PREFIX    = "CHANGE_TYPE_";

/**
 * If input is a CHANGE_TYPE_{roomTypeId} list-reply, return the roomTypeId.
 * Otherwise return null.
 */
export function parseChangeTypeReply(raw: string): string | null {
  const m = raw.trim().match(/^CHANGE_TYPE_(.+)$/i);
  return m ? m[1]! : null;
}

/**
 * Build the sections for the change-room-type list message.
 * candidates is the already-filtered list (current type excluded).
 */
export function buildChangeTypeSections(
  candidates: AllocationRoomInput[],
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const typeRows = candidates.map((r) => ({
    id:          `${CHANGE_TYPE_PREFIX}${r.roomTypeId}`,
    title:       r.name.slice(0, 24),
    description: `${inr(r.basePrice)}/night · ${r.availableCount} available`.slice(0, ROW_DESC_MAX),
  }));

  return [
    { title: "Available Room Types", rows: typeRows },
    { title: "Navigation",           rows: [{ id: CHANGE_TYPE_GO_BACK, title: "↩️ Go back" }] },
  ];
}

export type SendChangeRoomTypeListFn = (args: {
  hotelId:    string;
  guestId:    string;
  room:       AllocationRoom;
  roomIndex:  number;
  candidates: AllocationRoomInput[];
}) => Promise<boolean>;

export async function trySendChangeRoomTypeList(args: {
  hotelId:    string;
  guestId:    string;
  room:       AllocationRoom;
  roomIndex:  number;
  candidates: AllocationRoomInput[];
}): Promise<boolean> {
  const { hotelId, guestId, room, roomIndex, candidates } = args;
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return false;
  try {
    const creds = await resolveHotelGuest(hotelId, guestId);
    if (!creds) return false;
    const { phone, hotelPhone, phoneNumberId, accessToken } = creds;

    const bodyText    = `Change Room ${roomIndex + 1} to which type?`;
    const sections    = buildChangeTypeSections(candidates);
    const buttonLabel = "Choose Type";
    const footerText  = "Type MENU to cancel";
    const allRows     = sections.flatMap((s) => s.rows);

    const wamid = await sendListMessage(phone, phoneNumberId, accessToken, {
      bodyText,
      footerText,
      buttonLabel,
      sections,
    });

    await persistAndEmit(hotelId, guestId, hotelPhone, phone, wamid, bodyText, allRows);
    return true;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "change-room-type list send failed — falling back to text");
    return false;
  }
}

// ── Injectable sender 3: manual-mode overview ────────────────────────────────

export type SendManualModeListFn = (args: {
  hotelId: string;
  guestId: string;
  state:   AraState;
  addable: AllocationRoomInput[];
}) => Promise<boolean>;

export async function trySendManualModeList(args: {
  hotelId: string;
  guestId: string;
  state:   AraState;
  addable: AllocationRoomInput[];
}): Promise<boolean> {
  const { hotelId, guestId, state, addable } = args;
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return false;
  try {
    const creds = await resolveHotelGuest(hotelId, guestId);
    if (!creds) return false;
    const { phone, hotelPhone, phoneNumberId, accessToken } = creds;

    const total  = state.selectedRooms.reduce((s, r) => s + r.totalPrice, 0);
    const rooms  = state.selectedRooms;
    let summary  = `✏️ *Modify your booking*\n`;
    rooms.forEach((r, i) => {
      summary += `Room ${i + 1}: ${r.roomTypeName} — ${occupancyLabel(r)} — ${inr(r.totalPrice)}\n`;
    });
    summary += `\n*Total: ${inr(total)}*`;

    const sections   = buildManualModeSections(state, addable);
    const buttonLabel = "Edit Booking";
    const footerText  = "Type MENU to cancel";
    const allRows     = sections.flatMap((s) => s.rows);

    const wamid = await sendListMessage(phone, phoneNumberId, accessToken, {
      bodyText:    summary,
      footerText,
      buttonLabel,
      sections,
    });

    await persistAndEmit(hotelId, guestId, hotelPhone, phone, wamid, summary, allRows);
    return true;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "manual-mode list send failed — falling back to text");
    return false;
  }
}
