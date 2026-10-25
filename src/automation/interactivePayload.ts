/**
 * interactivePayload.ts
 *
 * Recognises a message that is EXACTLY one of the bot's own interactive reply
 * ids (list row / reply button / carousel button). The webhook hands the tapped
 * id to the bot verbatim (`botBody`), so a guest tapping an OLD list after their
 * session reset arrives here as e.g. "opt_2" — which must not be sent to the AI
 * as if it were a question.
 *
 * Anchored, whole-message, known formats only. Deliberately NOT ara/copy.ts's
 * PROTOCOL_LIKE: that one is unanchored (`\b`) because it hunts for ids INSIDE
 * hotel copy, so it would match "is plan_1 cheaper?" — and it omits the
 * flow-runtime ids (opt_, room_, photos_).
 *
 * Ids are imported from their senders where a constant exists, so a renamed id
 * cannot silently drift from this matcher.
 */

import { CANCEL_BTN_ID, CONFIRM_BTN_ID, MODIFY_BTN_ID } from "./nodes/ara/constants";
import {
  MOD_ADD_EXTRA_BED, MOD_REMOVE_EXTRA_BED, MOD_MOVE_GUEST_OUT, MOD_CHANGE_ROOM_TYPE,
  MOD_REMOVE_ROOM, MOD_GO_BACK, MOVE_GO_BACK, MODIFY_DONE, MODIFY_GO_BACK,
  MOVE_TO_ROOM_PREFIX, EDIT_ROOM_PREFIX, ADD_ROOM_PREFIX, CHANGE_TYPE_PREFIX,
} from "./nodes/modifyLists";

/** ARA "Mix it up" carousel row — a literal in araSenderPayloads.ts, no constant. */
const MIX_IT_UP_ID = "MIX_IT_UP";

/** `RoomType.id` is `@default(uuid())`. Requiring the uuid shape is what keeps
 *  natural text like "room_service" from matching the room_/photos_ prefixes. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const EXACT_IDS = new Set<string>([
  CONFIRM_BTN_ID, MODIFY_BTN_ID, CANCEL_BTN_ID, MIX_IT_UP_ID,
  MOD_ADD_EXTRA_BED, MOD_REMOVE_EXTRA_BED, MOD_MOVE_GUEST_OUT, MOD_CHANGE_ROOM_TYPE,
  MOD_REMOVE_ROOM, MOD_GO_BACK, MOVE_GO_BACK, MODIFY_DONE, MODIFY_GO_BACK,
]);

const PATTERNS: RegExp[] = [
  /^opt_\d+$/,                                     // options node rows       (flowRuntime trySendOptionsList)
  /^plan_\d+$/,                                    // ARA plan list rows      (planList.ts)
  new RegExp(`^room_(?:TYPE:)?${UUID}$`),          // show_rooms / ARA type carousel buttons
  new RegExp(`^photos_(?:TYPE:)?${UUID}$`),        // carousel "View Photos" (derived from room_ id)
  new RegExp(`^${MOVE_TO_ROOM_PREFIX}\\d+$`),      // modifyLists move-to-room rows (1-based slot)
  new RegExp(`^${EDIT_ROOM_PREFIX}\\d+$`),         // modifyLists edit-room rows
  new RegExp(`^${ADD_ROOM_PREFIX}${UUID}$`),       // modifyLists add-room rows (roomTypeId)
  new RegExp(`^${CHANGE_TYPE_PREFIX}${UUID}$`),    // modifyLists change-type rows (roomTypeId)
];

export function isInteractivePayloadId(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  return EXACT_IDS.has(s) || PATTERNS.some((re) => re.test(s));
}
