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

import { sendOutbound } from "../../services/outbound/outbound.service";
import { MessageChannel } from "@prisma/client";
import { logger } from "../../utils/logger";
import type {
  AllocationRoom,
  AllocationRoomInput,
  AraState,
  RoomConfigResolver,
} from "./advancedRoomAllocation";
import type { RoomAction } from "./ara/types";
import { DEFAULT_RESOLVED, fillKey, type ResolvedAraCopy } from "./ara/copy";

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

// Canonical definition lives in ara/types.ts; imported for local use and
// re-exported so existing importers of this module keep working and the two can
// never drift apart.
export type { RoomAction };

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
  copy:      ResolvedAraCopy = DEFAULT_RESOLVED,
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const modRows = options.map((a) => ({
    id:          ACTION_IDS[a],
    title:       ACTION_LABELS[a].slice(0, 24),
  }));

  return [
    { title: fillKey(copy, "lists.modifyRoomSection"), rows: modRows },
    { title: fillKey(copy, "lists.navigationSection"), rows: [{ id: MOD_GO_BACK, title: fillKey(copy, "lists.goBackRow") }] },
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
  copy:       ResolvedAraCopy = DEFAULT_RESOLVED,
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
    const desc = fillKey(copy, "lists.moveToRoomDesc", {
      adults:      r.adults,
      children:    r.children,
      maxAdults:   cfg.maxAdults,
      maxChildren: cfg.maxChildren,
    }).slice(0, ROW_DESC_MAX);
    rows.push({
      id:          `${MOVE_TO_ROOM_PREFIX}${slot}`,
      title:       r.roomTypeName.slice(0, 24),
      description: desc,
    });
  });

  const navRow = { id: MOVE_GO_BACK, title: fillKey(copy, "lists.goBackRow") };

  return {
    sections: [
      { title: fillKey(copy, "lists.availableRoomsSection"), rows },
      { title: fillKey(copy, "lists.navigationSection"),     rows: [navRow] },
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
  copy:    ResolvedAraCopy = DEFAULT_RESOLVED,
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const n = state.selectedRooms.length;

  const editRows = state.selectedRooms.map((r, i) => ({
    id:          `${EDIT_ROOM_PREFIX}${i + 1}`,
    title:       fillKey(copy, "lists.editRoomTitle", {
      roomNumber:   i + 1,
      roomTypeName: r.roomTypeName,
    }).slice(0, 24),
    description: fillKey(copy, "lists.editRoomDesc", {
      occupancy: occupancyLabel(r),
      total:     inr(r.totalPrice),
    }).slice(0, ROW_DESC_MAX),
  }));

  const addRows = addable.map((r, i) => ({
    id:          `${ADD_ROOM_PREFIX}${r.roomTypeId}`,
    title:       r.name.slice(0, 24),
    description: fillKey(copy, "lists.addRoomDesc", {
      maxAdults:   r.maxAdults   ?? "?",
      maxChildren: r.maxChildren ?? "?",
      price:       inr(r.basePrice),
      available:   r.availableCount,
    }).slice(0, ROW_DESC_MAX),
  }));

  const confirmRows = [
    { id: MODIFY_DONE,    title: fillKey(copy, "lists.confirmBookingRow") },
    { id: MODIFY_GO_BACK, title: fillKey(copy, "lists.goBackRow") },
  ];

  const sections: { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] = [];

  if (editRows.length > 0)  sections.push({ title: fillKey(copy, "lists.editExistingSection"), rows: editRows });
  if (addRows.length  > 0)  sections.push({ title: fillKey(copy, "lists.addRoomSection"),      rows: addRows  });
  sections.push({ title: fillKey(copy, "lists.confirmSection"), rows: confirmRows });

  return sections;
}

// Credential resolution, channel dispatch, persistence, and socket emit all
// live in sendOutbound (services/outbound) — these senders only build the
// logical "choice" payloads.

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
  channel:    MessageChannel;
  room:       AllocationRoom;
  options:    RoomAction[];
  roomIndex:  number;
  copy?:      ResolvedAraCopy | undefined;
}): Promise<boolean> {
  const { hotelId, guestId, channel, room, options, roomIndex } = args;
  const copy = args.copy ?? DEFAULT_RESOLVED;
  try {
    const bodyText = `*Room ${roomIndex + 1}: ${room.roomTypeName}*\n👥 ${occupancyLabel(room)}\n💰 ${inr(room.pricePerNight)}/night\n\nWhat would you like to do?`;
    const res = await sendOutbound({ hotelId, guestId, channel }, {
      kind:        "choice",
      bodyText,
      buttonLabel: fillKey(copy, "lists.buttonOptions"),
      footerText:  fillKey(copy, "lists.cancelFooter"),
      sections:    buildRoomMenuSections(room, options, copy),
    });
    return res.sent;
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
  channel:    MessageChannel;
  state:      AraState;
  fromIndex:  number;
  pending:    { adults: number; children: number };
  resolveCfg: RoomConfigResolver;
  copy?:      ResolvedAraCopy | undefined;
}): Promise<{ sent: boolean; destIndices: number[] }> {
  const { hotelId, guestId, channel, state, fromIndex, pending, resolveCfg } = args;
  const copy = args.copy ?? DEFAULT_RESOLVED;
  try {
    const { sections, destIndices } = buildMoveToRoomSections(state, fromIndex, pending, resolveCfg, copy);
    if (destIndices.length === 0) return { sent: false, destIndices: [] };

    const moving: string[] = [];
    if (pending.adults   > 0) moving.push(`${pending.adults} adult${pending.adults === 1 ? "" : "s"}`);
    if (pending.children > 0) moving.push(`${pending.children} child${pending.children > 1 ? "ren" : ""}`);

    const res = await sendOutbound({ hotelId, guestId, channel }, {
      kind:        "choice",
      bodyText:    `Move ${moving.join(", ")} to which room?`,
      buttonLabel: fillKey(copy, "lists.buttonChooseRoom"),
      footerText:  fillKey(copy, "lists.cancelFooter"),
      sections,
    });
    return { sent: res.sent, destIndices: res.sent ? destIndices : [] };
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
  copy:       ResolvedAraCopy = DEFAULT_RESOLVED,
): { title: string; rows: Array<{ id: string; title: string; description?: string }> }[] {
  const typeRows = candidates.map((r) => ({
    id:          `${CHANGE_TYPE_PREFIX}${r.roomTypeId}`,
    title:       r.name.slice(0, 24),
    description: fillKey(copy, "lists.changeTypeDesc", {
      price:     inr(r.basePrice),
      available: r.availableCount,
    }).slice(0, ROW_DESC_MAX),
  }));

  return [
    { title: fillKey(copy, "lists.availableTypesSection"), rows: typeRows },
    { title: fillKey(copy, "lists.navigationSection"),     rows: [{ id: CHANGE_TYPE_GO_BACK, title: fillKey(copy, "lists.goBackRow") }] },
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
  channel:    MessageChannel;
  room:       AllocationRoom;
  roomIndex:  number;
  candidates: AllocationRoomInput[];
  copy?:      ResolvedAraCopy | undefined;
}): Promise<boolean> {
  const { hotelId, guestId, channel, roomIndex, candidates } = args;
  const copy = args.copy ?? DEFAULT_RESOLVED;
  try {
    const res = await sendOutbound({ hotelId, guestId, channel }, {
      kind:        "choice",
      bodyText:    fillKey(copy, "changeType.listBody", { roomNumber: roomIndex + 1 }),
      buttonLabel: fillKey(copy, "lists.buttonChooseType"),
      footerText:  fillKey(copy, "lists.cancelFooter"),
      sections:    buildChangeTypeSections(candidates, copy),
    });
    return res.sent;
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
  channel: MessageChannel;
  state:   AraState;
  addable: AllocationRoomInput[];
  copy?:   ResolvedAraCopy | undefined;
}): Promise<boolean> {
  const { hotelId, guestId, channel, state, addable } = args;
  const copy = args.copy ?? DEFAULT_RESOLVED;
  try {
    const total  = state.selectedRooms.reduce((s, r) => s + r.totalPrice, 0);
    const rooms  = state.selectedRooms;
    let summary  = `✏️ *Modify your booking*\n`;
    rooms.forEach((r, i) => {
      summary += `Room ${i + 1}: ${r.roomTypeName} — ${occupancyLabel(r)} — ${inr(r.totalPrice)}\n`;
    });
    summary += `\n*Total: ${inr(total)}*`;

    const res = await sendOutbound({ hotelId, guestId, channel }, {
      kind:        "choice",
      bodyText:    summary,
      buttonLabel: fillKey(copy, "lists.buttonEditBooking"),
      footerText:  fillKey(copy, "lists.cancelFooter"),
      sections:    buildManualModeSections(state, addable, copy),
    });
    return res.sent;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "manual-mode list send failed — falling back to text");
    return false;
  }
}
