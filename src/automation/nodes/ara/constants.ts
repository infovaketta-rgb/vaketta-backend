/**
 * ara/constants.ts — every literal constant the node depends on.
 *
 * Two kinds live here and they must not be confused:
 *   • Tunables — safety ceilings and patience budgets (MAX_ROOMS, MAX_AGE_*).
 *   • Wire protocol — the interactive reply ids the sender modules emit and the
 *     webhook normalises guest taps back into. These are a machine contract, NOT
 *     guest-facing copy, and must never become hotel-configurable.
 */

import type { RoomAction } from "./types";

// ── Allocator ceiling ─────────────────────────────────────────────────────────

/** Absolute cap on rooms in one allocation. A memory guard, not a preference. */
export const MAX_ROOMS = 50;

// ── Formatting ────────────────────────────────────────────────────────────────

export const DIVIDER = "━━━━━━━━━━━━━━━━";

// ── Children-age collection budgets ───────────────────────────────────────────

/** Max age-collection rounds before we give up and fill remaining slots with 0. */
export const MAX_AGE_ROUNDS = 3;
/**
 * How many times the guest may reject the age read-back and re-enter the ages.
 * One. A second rejection proceeds with what we have, so reject → re-prompt can
 * never become a loop the guest cannot leave.
 */
export const MAX_AGE_CORRECTIONS = 1;

/**
 * Separators a guest puts between bare ages: commas, ampersands, hyphens/dashes,
 * and the word "and". Deliberately short — anything not listed here makes the
 * reply non-bare, which routes it to the AI rather than to a guess.
 */
export const AGE_LIST_SEPARATORS = /\band\b|[,&]|[-–—]/gi;

// ── Room-action menu labels ───────────────────────────────────────────────────

export const ROOM_ACTION_LABELS: Record<RoomAction, string> = {
  add_bed:     "Add extra bed",
  remove_bed:  "Remove extra bed",
  move_guest:  "Move a guest out",
  change_type: "Change room type",
  remove_room: "Remove this room",
};

// ── Session state key ─────────────────────────────────────────────────────────

export const ARA_KEY = "__araState__";

// ── Wire protocol: interactive reply ids ──────────────────────────────────────

// Interactive button ids (sent on the confirm summary). The webhook collapses a
// button_reply to a text body equal to the button id, so these arrive here as
// plain input alongside the legacy "1"/"2"/"MENU" replies.
export const CONFIRM_BTN_ID = "CONFIRM_BOOKING";
export const MODIFY_BTN_ID  = "MODIFY_BOOKING";
export const CANCEL_BTN_ID  = "CANCEL_BOOKING";

// ── Manual-mode prompts ───────────────────────────────────────────────────────

export const MODIFY_PROMPT = "Reply *DONE* to confirm, a room number to modify, or *MENU* to cancel.";
export const MODIFY_FAILED = "I couldn't make that change automatically.";
