/**
 * ara/keywords.ts — input matchers for every Phase-2 reply.
 *
 * Each matcher accepts BOTH the wire-protocol reply id (a button/list tap, which
 * the webhook collapses to a text body equal to the id) and the legacy typed
 * words. The ids are a machine contract and must always be accepted.
 */

import { CANCEL_BTN_ID, CONFIRM_BTN_ID, MODIFY_BTN_ID } from "./constants";
import type { RoomAction } from "./types";

export function isConfirmInput(raw: string): boolean {
  const s = raw.trim();
  if (s.toUpperCase() === CONFIRM_BTN_ID) return true;
  const l = s.toLowerCase();
  return l === "1" || l === "confirm";
}
export function isModifyInput(raw: string): boolean {
  const s = raw.trim();
  if (s.toUpperCase() === MODIFY_BTN_ID) return true;
  const l = s.toLowerCase();
  return l === "2" || l === "modify";
}
export function isMenuInput(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  return s === "MENU" || s === CANCEL_BTN_ID;
}
export function isDoneInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (s === "done" || s === "confirm") return true;
  if (raw.trim().toUpperCase() === "MODIFY_DONE") return true;
  return false;
}
// ── List-reply id helpers for Phase 2 ────────────────────────────────────────

/** True when the input is a "go back" action from any Phase-2 list reply. */
export function isGoBackInput(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  return s === "0" || s === "MOD_GO_BACK" || s === "MOVE_GO_BACK" || s === "MODIFY_GO_BACK";
}

/**
 * If input is a room-menu list-reply id (MOD_REMOVE_EXTRA_BED etc.), return the
 * equivalent 1-based option number; otherwise return null.
 * The options array is the one returned by roomMenuOptions() — same order.
 */
export function roomMenuListReplyToIdx(
  raw:     string,
  options: RoomAction[],
): number | null {
  const MAP: Record<string, RoomAction> = {
    MOD_ADD_EXTRA_BED:    "add_bed",
    MOD_REMOVE_EXTRA_BED: "remove_bed",
    MOD_MOVE_GUEST_OUT:   "move_guest",
    MOD_CHANGE_ROOM_TYPE: "change_type",
    MOD_REMOVE_ROOM:      "remove_room",
  };
  const action = MAP[raw.trim().toUpperCase()];
  if (!action) return null;
  const idx = options.indexOf(action);
  return idx >= 0 ? idx + 1 : null; // 1-based, matching the text handler
}

/**
 * If input is a MOVE_TO_ROOM_{n} list-reply, return the slot number (1-based).
 * Otherwise return null.
 */
export function parseMoveToRoomSlot(raw: string): number | null {
  const m = raw.trim().match(/^MOVE_TO_ROOM_(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * If input is an EDIT_ROOM_{n} or ADD_ROOM_{id} list-reply from the manual-mode
 * overview, return { kind: "edit", slot } or { kind: "add", roomTypeId }.
 * Otherwise return null.
 */
export function parseManualListReply(raw: string): { kind: "edit"; slot: number } | { kind: "add"; roomTypeId: string } | null {
  const s = raw.trim();
  const editM = s.match(/^EDIT_ROOM_(\d+)$/i);
  if (editM) {
    const n = parseInt(editM[1]!, 10);
    return Number.isFinite(n) && n >= 1 ? { kind: "edit", slot: n } : null;
  }
  const addM = s.match(/^ADD_ROOM_(.+)$/i);
  if (addM) return { kind: "add", roomTypeId: addM[1]! };
  return null;
}

/** Guest said the read-back ages are right. Reuses the confirm-step matchers. */
export function isAgeConfirmInput(raw: string): boolean {
  const l = raw.trim().toLowerCase();
  return isConfirmInput(raw) || l === "yes" || l === "y";
}

/** Guest said they are wrong and wants to re-enter them. */
export function isAgeRejectInput(raw: string): boolean {
  const l = raw.trim().toLowerCase();
  return isModifyInput(raw) || l === "no" || l === "n";
}
