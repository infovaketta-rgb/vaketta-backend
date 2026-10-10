/**
 * ara/render.ts — every guest-facing text builder (pure).
 *
 * No I/O and no deps: each function takes data and returns a string, so the
 * handler can render the same text whether or not an interactive sender is
 * available. The copy itself is still hardcoded here; routing it through a
 * configurable registry is a later stage.
 */

import { DIVIDER, ROOM_ACTION_LABELS } from "./constants";
import { formatAges } from "./ages";
import { inr } from "./money";
import { planTypeName } from "./plans";
import type {
  AllocationConfig,
  AllocationPlan,
  AllocationRoom,
  AllocationRoomInput,
  AraState,
  RoomAction,
  RoomConfigResolver,
} from "./types";

export function renderAllocationSummary(
  allocated: AllocationRoom[],
  opts?: { trailing?: string; childrenAges?: number[] | undefined },
): string {
  const childrenAges = opts?.childrenAges ?? [];
  let text = `🛏 *Suggested Allocation*\n${DIVIDER}\n`;
  allocated.forEach((r, i) => {
    // Show ages only when this room's children count matches the ages provided
    // (unambiguous — e.g. a single room holding all the children).
    let childPart = "";
    if (r.children > 0) {
      childPart = childrenAges.length > 0 && r.children === childrenAges.length
        ? `, children aged ${formatAges(childrenAges)}`
        : `, ${r.children} child${r.children > 1 ? "ren" : ""}`;
    }
    text += `*Room ${i + 1}: ${r.roomTypeName}*\n`;
    text += `👥 ${r.adults} adult${r.adults > 1 ? "s" : ""}${childPart}\n`;
    if (r.extraBed) text += `🛏 Extra bed included\n`;

    // Price breakdown — only show the lines that carry a non-zero charge.
    const nightsLine = `${inr(r.pricePerNight)}/night × ${r.nights} night${r.nights > 1 ? "s" : ""} = *${inr(r.totalPrice)}*`;
    const parts: string[] = [];
    if (r.extraAdultCost > 0) parts.push(`${inr(r.extraAdultCost)} extra adult`);
    if (r.extraBedCost   > 0) parts.push(`${inr(r.extraBedCost)} extra bed`);
    if (parts.length > 0) {
      text += `💰 ${inr(r.basePrice)} base + ${parts.join(" + ")}\n   = ${nightsLine}\n`;
    } else {
      text += `💰 ${nightsLine}\n`;
    }
  });
  const total = allocated.reduce((s, r) => s + r.totalPrice, 0);
  text += `${DIVIDER}\n*Total: ${inr(total)}*`;

  // Informational age-limit note (childAgeLimit is display-only — no automatic
  // reclassification, since guest input does not include individual ages).
  const ageLimit = allocated.find((r) => r.childAgeLimit != null)?.childAgeLimit;
  if (ageLimit != null) {
    text += `\n_Note: Children above ${ageLimit} years are charged as adults._`;
  }

  if (opts?.trailing) text += `\n\n${opts.trailing}`;
  return text;
}

export function confirmPromptFooter(): string {
  return "Reply *1* to Confirm\nReply *2* to Modify manually\nReply *MENU* to cancel";
}
export function buildManualRoomList(rooms: AllocationRoomInput[], remaining: { adults: number; children: number }): string {
  let text = `Pick a room to add to your booking. *${remaining.adults} adult${remaining.adults === 1 ? "" : "s"}` +
    (remaining.children > 0 ? `, ${remaining.children} child${remaining.children > 1 ? "ren" : ""}` : "") +
    `* still need a room.\n\n${DIVIDER}\n`;
  rooms.forEach((r, i) => {
    const cap: string[] = [];
    if (r.maxAdults != null) cap.push(`${r.maxAdults} adults`);
    if (r.maxChildren != null && r.maxChildren > 0) cap.push(`${r.maxChildren} child`);
    const capPart = cap.length ? ` _(fits ${cap.join(", ")})_` : "";
    const availPart = ` _(${r.availableCount} avail)_`;
    text += `*${i + 1}.* ${r.name}${capPart}${availPart} — ${inr(r.basePrice)}/night\n`;
  });
  text += `${DIVIDER}\n\nReply *1–${rooms.length}* to add a room.\nReply *DONE* when finished.\nReply *MENU* to cancel.`;
  return text;
}

/** Room types the guest can still add: availableCount minus what's already
 *  selected of that type, > 0. Used for the optional "add another room" list. */
export function addableRooms(rooms: AllocationRoomInput[], selected: AllocationRoom[]): AllocationRoomInput[] {
  return rooms.filter((r) => {
    const picked = selected.filter((s) => s.roomTypeId === r.roomTypeId).length;
    return r.availableCount - picked > 0;
  });
}

/** Room-type capacity hint, e.g. " _(fits 3 adults, 1 child)_". */
export function capHint(r: { maxAdults: number | null; maxChildren: number | null }): string {
  const cap: string[] = [];
  if (r.maxAdults != null) cap.push(`${r.maxAdults} adults`);
  if (r.maxChildren != null && r.maxChildren > 0) cap.push(`${r.maxChildren} child`);
  return cap.length ? ` _(fits ${cap.join(", ")})_` : "";
}

/** Occupancy phrase for a room, e.g. "2 adults, 1 child, extra bed". */
export function occupancyPhrase(room: AllocationRoom): string {
  const parts = [`${room.adults} adult${room.adults === 1 ? "" : "s"}`];
  if (room.children > 0) parts.push(`${room.children} child${room.children > 1 ? "ren" : ""}`);
  if (room.extraBed) parts.push("extra bed");
  return parts.join(", ");
}
/**
 * The actions offered for a room, in fixed order. Pure function of the room +
 * its config, so render and handler derive the SAME numbered list without
 * storing the mapping in state. `change_type` is offered unconditionally (kept
 * stable across turns — whether other types are actually available is checked
 * when the guest enters the change-type picker, not here).
 */
export function roomMenuOptions(room: AllocationRoom, cfg: AllocationConfig): RoomAction[] {
  const opts: RoomAction[] = [];
  if (cfg.allowExtraBed && !room.extraBed) opts.push("add_bed");
  if (room.extraBed)                       opts.push("remove_bed");
  if (room.adults > 0 || room.children > 0) opts.push("move_guest");
  opts.push("change_type");
  opts.push("remove_room");
  return opts;
}
/**
 * Manual-mode prompt: existing rooms are editable (numbered 1..N), with an
 * OPTIONAL add-room list numbered AFTER them (N+1..N+M). Fully navigable with
 * no AI. When nothing is addable, only the edit list + DONE/MENU are shown.
 */
export function renderManualMode(state: AraState, addable: AllocationRoomInput[]): string {
  const n = state.selectedRooms.length;
  let text = `✏️ *Modify your booking*\n${DIVIDER}\n`;
  state.selectedRooms.forEach((r, i) => {
    text += `*Room ${i + 1}: ${r.roomTypeName}* — ${occupancyPhrase(r)} — ${inr(r.totalPrice)}\n`;
  });
  const total = state.selectedRooms.reduce((s, r) => s + r.totalPrice, 0);
  text += `${DIVIDER}\n*Total: ${inr(total)}*\n`;
  if (n > 0) text += `\nReply *1–${n}* to edit a room.\n`;
  if (addable.length > 0) {
    text += `\n➕ *Add a room:*\n`;
    addable.forEach((r, i) => {
      text += `*${n + i + 1}.* ${r.name}${capHint(r)} _(${r.availableCount} avail)_ — ${inr(r.basePrice)}/night\n`;
    });
  }
  text += `\nReply *DONE* to confirm · *MENU* to cancel`;
  return text;
}

/** Per-room action menu (room_menu phase). */
export function renderRoomMenu(room: AllocationRoom, options: RoomAction[], roomIndex: number): string {
  let text = `*Room ${roomIndex + 1}: ${room.roomTypeName}*\n👥 ${occupancyPhrase(room)}\n💰 ${inr(room.pricePerNight)}/night\n\nWhat would you like to do?\n${DIVIDER}\n`;
  options.forEach((a, i) => { text += `*${i + 1}.* ${ROOM_ACTION_LABELS[a]}\n`; });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel`;
  return text;
}

/** "How many to move out" prompt (move_from_count phase). */
export function renderMoveFromCount(room: AllocationRoom, roomIndex: number): string {
  return `Moving guests out of *Room ${roomIndex + 1}: ${room.roomTypeName}*\n` +
    `(currently ${room.adults} adult${room.adults === 1 ? "" : "s"}, ${room.children} child${room.children === 1 ? "" : "ren"})\n\n` +
    `How many adults and children to move?\n` +
    `Format: *adults children*  e.g. *1 0* for 1 adult, 0 children.\n` +
    `Reply *0* to go back · *MENU* to cancel.`;
}

/** Destination picker (move_to_room phase). Lists every room except the source,
 *  numbered 1.. in display order, with current occupancy + caps. */
export function renderMoveToRoom(
  state: AraState,
  pending: { adults: number; children: number },
  fromIndex: number,
  resolveCfg: RoomConfigResolver,
): string {
  const moving: string[] = [];
  if (pending.adults > 0)   moving.push(`${pending.adults} adult${pending.adults === 1 ? "" : "s"}`);
  if (pending.children > 0) moving.push(`${pending.children} child${pending.children > 1 ? "ren" : ""}`);
  let text = `Move ${moving.join(", ")} to which room?\n${DIVIDER}\n`;
  let n = 0;
  state.selectedRooms.forEach((r, i) => {
    if (i === fromIndex) return;
    n++;
    const cfg = resolveCfg(r);
    text += `*${n}.* ${r.roomTypeName} — currently ${r.adults} adults, ${r.children} child (max ${cfg.maxAdults} adults, ${cfg.maxChildren} child)\n`;
  });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel.`;
  return text;
}

/** Room types the room can switch to: every type except its current one. Catalog-
 *  based (stable ordering across turns); availability is validated on apply. */
export function changeTypeCandidates(rooms: AllocationRoomInput[], current: AllocationRoom): AllocationRoomInput[] {
  return rooms.filter((r) => r.roomTypeId !== current.roomTypeId);
}

/** New-room-type picker (change_type_select phase). */
export function renderChangeTypeSelect(room: AllocationRoom, candidates: AllocationRoomInput[], roomIndex: number): string {
  let text = `Change *Room ${roomIndex + 1}: ${room.roomTypeName}* (currently ${occupancyPhrase(room)}) to which type?\n${DIVIDER}\n`;
  candidates.forEach((r, i) => {
    text += `*${i + 1}.* ${r.name}${capHint(r)} _(${r.availableCount} avail)_ — ${inr(r.basePrice)}/night\n`;
  });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel.`;
  return text;
}
/** Text fallback when the carousel can't be sent (or only 2 plans). Pure. */
export function renderPlanTextFallback(plans: AllocationPlan[]): string {
  let text = `🏨 *Choose your room plan:*\n${DIVIDER}\n`;
  plans.forEach((p, i) => {
    const beds = p.extraBedCount > 0 ? "Extra beds incl." : "No extra beds";
    text += `*${i + 1}. ${p.label} — ${inr(p.totalPrice)}*\n`;
    text += `   ${p.roomCount} room${p.roomCount === 1 ? "" : "s"} · ${planTypeName(p)} · ${beds}\n`;
    p.rooms.forEach((r, j) => {
      text += `   Room ${j + 1}: ${r.roomTypeName} — ${occupancyPhrase(r)}\n`;
    });
  });
  text += `${DIVIDER}\nReply *1–${plans.length}* to choose · *MENU* to cancel`;
  return text;
}

/**
 * Room-descriptions text (Piece 1D). One block per AVAILABLE room type:
 *   *{name}* — ₹{basePrice}/night
 *   _{description}_   ← omitted entirely when the type has no description
 * WhatsApp-safe (bold/italic/newlines only). Pure + exported. Returns null when
 * there are no available room types (caller skips the send).
 */
export function buildRoomDescriptionsMessage(rooms: AllocationRoomInput[]): string | null {
  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const available = rooms.filter((r) => r.availableCount > 0);
  if (available.length === 0) return null;

  const blocks = available.map((r) => {
    const head = `*${r.name}* — ${inr(r.basePrice)}/night`;
    const desc = (r.description ?? "").trim();
    return desc ? `${head}\n_${desc}_` : head; // no empty italic line when blank
  });

  return (
    `🏨 *Our Room Types*\n\n` +
    `${blocks.join("\n\n")}\n\n` +
    `_Tap the options below to choose your preferred room type_ 👇`
  );
}
