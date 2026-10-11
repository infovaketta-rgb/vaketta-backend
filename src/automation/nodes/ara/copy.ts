/**
 * ara/copy.ts — the single registry of guest-facing copy for the ARA node.
 *
 * STAGE 1 IS INERT. Nothing reads this registry at runtime yet; the call sites
 * still hold their own literals. That duplication is deliberate and temporary,
 * and it is policed: `copy.test.ts` asserts every default here is byte-identical
 * to what the code actually emits today, so editing either side alone fails.
 * The wiring stage replaces the literals with lookups; until then this file
 * changes no behaviour whatsoever.
 *
 * WHAT BELONGS HERE
 *   Whole messages, headers, footers, prompts, rejection reasons, action labels,
 *   list section titles and button labels — anything a hotel might reasonably
 *   want to reword.
 *
 * WHAT DOES NOT, AND WHY
 *   • Protocol identifiers — CONFIRM_BOOKING, MOD_ADD_EXTRA_BED, MOVE_TO_ROOM_{n},
 *     plan_{n}, room_TYPE:{id} and friends (see ./constants). The webhook
 *     collapses a tap to a body equal to the id, so these are a machine contract
 *     between the sender modules and the handler. A hotel editing one would
 *     silently break every button. `copy.test.ts` rejects any default that looks
 *     like one.
 *   • Operational safety constants — MAX_ROOMS, MAX_AGE_ROUNDS/CORRECTIONS, and
 *     the Meta platform caps (1024 body, 24 row title, 72 row desc, 20 button).
 *     Exceeding a Meta cap yields a 400 and a silently unsent message.
 *   • The per-room line assembly inside renderAllocationSummary and the plan
 *     block builder in planList.ts. These interleave emoji, conditional
 *     price-breakdown lines and pluralisation inside a loop; every byte is a
 *     risk multiplier and no hotel asks to reword them. Only their header, total
 *     and notes are keys here.
 *
 * PLURALISATION NEVER LIVES IN A TEMPLATE.
 *   A `{{n}} child{{suffix}}` key would let a hotel break grammar, and it cannot
 *   express occupancyPhrase's "omit the clause entirely at zero". Each branch
 *   gets its own key with a `note` naming the condition that selects it.
 *
 * KNOWN INCONSISTENCIES ARE PRESERVED, NOT CORRECTED.
 *   `lists.cancelFooter` really does say "Type 'Hi' to cancel" while the node
 *   only matches MENU/CANCEL_BOOKING, and the money formatters disagree about
 *   rounding. Both are pinned by goldens so a later fix is a visible diff.
 *   Do not "tidy" them here.
 */

import { interpolate } from "../../interpolate";

// ── Spec ──────────────────────────────────────────────────────────────────────

/** Which source file holds the literal this key mirrors. Drives how
 *  `copy.test.ts` verifies it: a pure exported builder can be CALLED, an inline
 *  literal inside a phase/handler/flowRuntime can only be SOURCE-SCANNED. */
export type AraCopyOrigin =
  | "render" | "ages" | "appliers" | "constants" | "plans" | "dates"
  | "phases" | "handler" | "planList" | "modifyLists" | "flowRuntime";

export type AraCopyGroup =
  | "ages" | "occupancy" | "dates" | "guests" | "soldOut" | "preference"
  | "summary" | "confirm" | "manual" | "roomMenu" | "move" | "changeType"
  | "plans" | "rooms" | "lists" | "rejections";

/** Where a string lands, so the wiring stage applies the right Meta cap. */
export type AraCopyKind =
  | "body" | "footer" | "prompt" | "header" | "button"
  | "row.title" | "row.desc" | "section.title" | "fragment";

export interface AraCopySpec {
  /** Byte-identical to the literal the code emits today, with `${x}` → `{{x}}`. */
  readonly default: string;
  /** Every `{{token}}` this key may use. Checked both ways by copy.test.ts. */
  readonly vars?: readonly string[];
  /** Meta cap that applies at this key's position, when one does. */
  readonly maxLen?: number;
  readonly kind: AraCopyKind;
  readonly group: AraCopyGroup;
  readonly origin: AraCopyOrigin;
  /** Required when a key is one arm of a branch, or shares a default with
   *  another key — says which condition selects it, so the split is not
   *  mistaken for an accident. */
  readonly note?: string;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const ARA_COPY = {

  // ── Children's-age collection ───────────────────────────────────────────────

  "ages.askOne": {
    default: "How old is your child? 👶",
    kind: "prompt", group: "ages", origin: "phases",
    note: "children === 1 arm of the phase-1 age ask.",
  },
  "ages.askMany": {
    default: "Please share the ages of your {{children}} children — e.g. 5, 8 and 12 👶",
    vars: ["children"],
    kind: "prompt", group: "ages", origin: "phases",
    note: "children > 1 arm; 'children' stays literal because this arm is never singular.",
  },
  "ages.nudge": {
    default: "I just need the ages of your children to continue — e.g. 5, 8 and 12 👶",
    kind: "prompt", group: "ages", origin: "phases",
    note: "Nothing parsed this round and the round budget is not yet spent.",
  },
  "ages.gotPartialOne": {
    default: "Got {{ages}} — what's the age of your other {{remaining}} child?",
    vars: ["ages", "remaining"],
    kind: "prompt", group: "ages", origin: "phases",
    note: "remaining === 1 arm.",
  },
  "ages.gotPartialMany": {
    default: "Got {{ages}} — what's the age of your other {{remaining}} children?",
    vars: ["ages", "remaining"],
    kind: "prompt", group: "ages", origin: "phases",
    note: "remaining > 1 arm.",
  },
  "ages.corruptState": {
    default: "Something went wrong collecting the children's ages. Please start over from the main menu.",
    kind: "body", group: "ages", origin: "phases",
  },
  "ages.confirmPrompt": {
    default: "Just to confirm — {{subject}} aged *{{ages}}*.",
    vars: ["subject", "ages"],
    kind: "body", group: "ages", origin: "ages",
  },
  "ages.confirmSubjectOne": {
    default: "your child is",
    kind: "fragment", group: "ages", origin: "ages",
    note: "ages.length === 1 arm of ages.confirmPrompt's subject.",
  },
  "ages.confirmSubjectMany": {
    default: "your {{count}} children are",
    vars: ["count"],
    kind: "fragment", group: "ages", origin: "ages",
    note: "ages.length > 1 arm of ages.confirmPrompt's subject.",
  },
  "ages.confirmFooter": {
    default: "Reply *1* if that's right\nReply *2* to correct the ages\nReply *MENU* to cancel",
    kind: "footer", group: "ages", origin: "ages",
    note: "Used only when no interactive button sender is injected.",
  },
  "ages.rejectedReprompt": {
    default: "No problem — please send the ages as a plain list, oldest first, e.g. *12, 8, 5* 👶",
    kind: "prompt", group: "ages", origin: "phases",
  },

  // ── Occupancy notice (children reclassified as adults) ─────────────────────

  "occupancy.noticeHeader": {
    default: "*Occupancy Summary* 👥",
    kind: "header", group: "occupancy", origin: "ages",
  },
  "occupancy.noticeCounts": {
    default: "Adults: *{{adults}}*   Children: *{{children}}*",
    vars: ["adults", "children"],
    kind: "body", group: "occupancy", origin: "ages",
    note: "Three spaces between the two counts — not a typo, it is the column gap.",
  },
  "occupancy.noticeWhoOne": {
    default: "One of your children is",
    kind: "fragment", group: "occupancy", origin: "ages",
    note: "promotedToAdult <= 1 arm.",
  },
  "occupancy.noticeWhoMany": {
    default: "{{promoted}} of your children are",
    vars: ["promoted"],
    kind: "fragment", group: "occupancy", origin: "ages",
    note: "promotedToAdult > 1 arm.",
  },
  "occupancy.noticeCountedOne": {
    default: "an adult",
    kind: "fragment", group: "occupancy", origin: "ages",
    note: "promotedToAdult <= 1 arm.",
  },
  "occupancy.noticeCountedMany": {
    default: "adults",
    kind: "fragment", group: "occupancy", origin: "ages",
    note: "promotedToAdult > 1 arm.",
  },
  "occupancy.noticeBody": {
    default: "_{{who}} above {{ageLimit}} years and will be counted as {{counted}} per hotel policy._",
    vars: ["who", "ageLimit", "counted"],
    kind: "body", group: "occupancy", origin: "ages",
  },

  // ── Stay dates ─────────────────────────────────────────────────────────────

  "dates.missingRetry": {
    default: "I still need your stay dates to suggest rooms — let's fill that in. 👍",
    kind: "prompt", group: "dates", origin: "dates",
  },
  "dates.missingTerminal": {
    default: "I don't have your check-in / check-out dates yet. Please start over from the main menu.",
    kind: "body", group: "dates", origin: "dates",
    note: "Reached only when no retry rewind is possible.",
  },
  "dates.reversedRetry": {
    default: "Your check-out date ({{checkOut}}) must be *after* your check-in date ({{checkIn}}). Let's fix just that — everything else is saved. 👍",
    vars: ["checkOut", "checkIn"],
    kind: "prompt", group: "dates", origin: "dates",
    note: "Built from two concatenated literals in source, so the source scan checks segments.",
  },
  "dates.reversedTerminal": {
    default: "Check-out must be after check-in. Please start over from the main menu.",
    kind: "body", group: "dates", origin: "dates",
  },

  // ── Guest counts ───────────────────────────────────────────────────────────

  "guests.zeroRetry": {
    default: "I need at least one guest to suggest rooms — how many people are staying?",
    kind: "prompt", group: "guests", origin: "phases",
  },
  "guests.zeroTerminal": {
    default: "I need at least one guest to allocate a room. Please start over from the main menu.",
    kind: "body", group: "guests", origin: "phases",
  },

  // ── Sold out / inventory exhausted ─────────────────────────────────────────

  "soldOut.retry": {
    default: "Sorry, we don't have enough rooms for {{guests}} guests on those dates. Try different dates and I'll check again — your other details are saved. 👍",
    vars: ["guests"],
    kind: "prompt", group: "soldOut", origin: "phases",
    note: "Two sites (pre-carousel feasibility, post-preference plan generation) with identical text.",
  },
  "soldOut.terminal": {
    default: "Sorry, we don't have enough rooms for {{guests}} guests on those dates. Please contact us directly or try different dates.",
    vars: ["guests"],
    kind: "body", group: "soldOut", origin: "phases",
    note: "Same two sites, when no retry rewind is possible.",
  },

  // ── Room-type preference ───────────────────────────────────────────────────

  "preference.mixTextFallback": {
    default: "_Not sure? Reply *MIX* and we'll pick the best combination for you_ 🎲",
    kind: "body", group: "preference", origin: "phases",
    note: "Only when no sendMixItUpList dep is injected. Says MIX; the interactive variant is flowRuntime.mixBody.",
  },
  "preference.unrecognised": {
    default: "Please tap a room type from the cards above, or *Mix it up 🎲* to let us choose. Reply *MENU* to cancel.",
    kind: "prompt", group: "preference", origin: "handler",
  },

  // ── Allocation summary ─────────────────────────────────────────────────────

  "summary.header": {
    default: "🛏 *Suggested Allocation*",
    kind: "header", group: "summary", origin: "render",
  },
  "summary.extraBedLine": {
    default: "🛏 Extra bed included",
    kind: "fragment", group: "summary", origin: "render",
  },
  "summary.total": {
    default: "*Total: {{total}}*",
    vars: ["total"],
    kind: "fragment", group: "summary", origin: "render",
    note: "Shared verbatim by renderAllocationSummary and renderManualMode.",
  },
  "summary.ageLimitNote": {
    default: "_Note: Children above {{ageLimit}} years are charged as adults._",
    vars: ["ageLimit"],
    kind: "footer", group: "summary", origin: "render",
  },
  "summary.divider": {
    default: "━━━━━━━━━━━━━━━━",
    kind: "fragment", group: "summary", origin: "constants",
    note: "Must stay equal to DIVIDER in ./constants; asserted in copy.test.ts.",
  },

  // ── Confirm step ───────────────────────────────────────────────────────────

  "confirm.footer": {
    default: "Reply *1* to Confirm\nReply *2* to Modify manually\nReply *MENU* to cancel",
    kind: "footer", group: "confirm", origin: "render",
    note: "Used only when no sendConfirmButtons dep is injected.",
  },
  "confirm.reprompt": {
    default: "Please reply *1* to confirm, *2* to modify, or *MENU* to cancel.",
    kind: "prompt", group: "confirm", origin: "phases",
    note: "Identical text in phases/confirm.phase.ts and handler.ts.",
  },
  "confirm.buttonConfirm": {
    default: "✅ Confirm",
    maxLen: 20,
    kind: "button", group: "confirm", origin: "flowRuntime",
    note: "Title only. Its id CONFIRM_BOOKING is wire protocol and is NOT in this registry.",
  },
  "confirm.buttonModify": {
    default: "✏️ Modify",
    maxLen: 20,
    kind: "button", group: "confirm", origin: "flowRuntime",
    note: "Title only. Its id MODIFY_BOOKING is wire protocol.",
  },
  "confirm.buttonCancel": {
    default: "✖️ Cancel",
    maxLen: 20,
    kind: "button", group: "confirm", origin: "flowRuntime",
    note: "Title only. Its id CANCEL_BOOKING is wire protocol.",
  },

  // ── Manual mode ────────────────────────────────────────────────────────────

  "manual.header": {
    default: "✏️ *Modify your booking*",
    kind: "header", group: "manual", origin: "render",
    note: "Shared by renderManualMode and trySendManualModeList's body, which otherwise differ — see copy.golden.test.ts.",
  },
  "manual.editHint": {
    default: "Reply *1–{{count}}* to edit a room.",
    vars: ["count"],
    kind: "prompt", group: "manual", origin: "render",
    note: "En dash in the range, not a hyphen.",
  },
  "manual.addHeader": {
    default: "➕ *Add a room:*",
    kind: "header", group: "manual", origin: "render",
  },
  "manual.footer": {
    default: "Reply *DONE* to confirm · *MENU* to cancel",
    kind: "footer", group: "manual", origin: "render",
  },
  "manual.prompt": {
    default: "Reply *DONE* to confirm, a room number to modify, or *MENU* to cancel.",
    kind: "prompt", group: "manual", origin: "constants",
    note: "Must stay equal to MODIFY_PROMPT in ./constants.",
  },
  "manual.failed": {
    default: "I couldn't make that change automatically.",
    kind: "body", group: "manual", origin: "constants",
    note: "Must stay equal to MODIFY_FAILED in ./constants.",
  },
  "manual.reprompt": {
    default: "Please reply with a room number (1–{{count}}), *DONE* to finish, or *MENU* to cancel.",
    vars: ["count"],
    kind: "prompt", group: "manual", origin: "phases",
    note: "Identical text in phases/confirm.phase.ts and handler.ts. En dash in the range.",
  },
  "manual.noRoomsPicked": {
    default: "You haven't picked any rooms yet. ",
    kind: "fragment", group: "manual", origin: "handler",
    note: "TRAILING SPACE IS LOAD-BEARING — buildManualRoomList is concatenated directly after it.",
  },
  "manual.pickHeader": {
    default: "Pick a room to add to your booking. *{{occupancy}}* still need a room.",
    vars: ["occupancy"],
    kind: "header", group: "manual", origin: "render",
    note: "occupancy is pre-built in TS so the pluralisation and the optional children clause stay in code.",
  },
  "manual.pickFooter": {
    default: "Reply *1–{{count}}* to add a room.\nReply *DONE* when finished.\nReply *MENU* to cancel.",
    vars: ["count"],
    kind: "footer", group: "manual", origin: "render",
  },

  // ── Per-room action menu ───────────────────────────────────────────────────

  "roomMenu.question": {
    default: "What would you like to do?",
    kind: "prompt", group: "roomMenu", origin: "render",
    note: "Shared by renderRoomMenu and trySendRoomMenuList's body.",
  },
  "roomMenu.footer": {
    default: "Reply *0* to go back · *MENU* to cancel",
    kind: "footer", group: "roomMenu", origin: "render",
    note: "NO trailing period — unlike move.goBackFooter, which is the same words with one. Preserved deliberately.",
  },
  "roomMenu.actionAddBed": {
    default: "Add extra bed",
    maxLen: 24,
    kind: "row.title", group: "roomMenu", origin: "constants",
    note: "Must stay equal to ROOM_ACTION_LABELS.add_bed.",
  },
  "roomMenu.actionRemoveBed": {
    default: "Remove extra bed",
    maxLen: 24,
    kind: "row.title", group: "roomMenu", origin: "constants",
    note: "Must stay equal to ROOM_ACTION_LABELS.remove_bed.",
  },
  "roomMenu.actionMoveGuest": {
    default: "Move a guest out",
    maxLen: 24,
    kind: "row.title", group: "roomMenu", origin: "constants",
    note: "Must stay equal to ROOM_ACTION_LABELS.move_guest.",
  },
  "roomMenu.actionChangeType": {
    default: "Change room type",
    maxLen: 24,
    kind: "row.title", group: "roomMenu", origin: "constants",
    note: "Must stay equal to ROOM_ACTION_LABELS.change_type.",
  },
  "roomMenu.actionRemoveRoom": {
    default: "Remove this room",
    maxLen: 24,
    kind: "row.title", group: "roomMenu", origin: "constants",
    note: "Must stay equal to ROOM_ACTION_LABELS.remove_room.",
  },

  // ── Moving guests between rooms ────────────────────────────────────────────

  "move.fromCountHeader": {
    default: "Moving guests out of *Room {{roomNumber}}: {{roomTypeName}}*",
    vars: ["roomNumber", "roomTypeName"],
    kind: "header", group: "move", origin: "render",
  },
  "move.fromCountCurrent": {
    default: "(currently {{occupancy}})",
    vars: ["occupancy"],
    kind: "fragment", group: "move", origin: "render",
    note: "occupancy is built inline in renderMoveFromCount and ALWAYS prints the children clause, even at zero — unlike occupancyPhrase. See copy.golden.test.ts.",
  },
  "move.fromCountQuestion": {
    default: "How many adults and children to move?",
    kind: "prompt", group: "move", origin: "render",
  },
  "move.fromCountFormat": {
    default: "Format: *adults children*  e.g. *1 0* for 1 adult, 0 children.",
    kind: "prompt", group: "move", origin: "render",
    note: "Two spaces before 'e.g.' — preserved.",
  },
  "move.goBackFooter": {
    default: "Reply *0* to go back · *MENU* to cancel.",
    kind: "footer", group: "move", origin: "render",
    note: "WITH trailing period. roomMenu.footer is the same words without one. Also used by renderMoveToRoom and renderChangeTypeSelect.",
  },
  "move.toRoomHeader": {
    default: "Move {{moving}} to which room?",
    vars: ["moving"],
    kind: "header", group: "move", origin: "render",
    note: "Shared verbatim by renderMoveToRoom and trySendMoveToRoomList's body.",
  },
  "move.invalidCount": {
    default: "Please reply like *1 0* (adults children) — at least one above 0, and no more than the room has.",
    kind: "prompt", group: "move", origin: "handler",
  },

  // ── Changing a room's type ─────────────────────────────────────────────────

  "changeType.header": {
    default: "Change *Room {{roomNumber}}: {{roomTypeName}}* (currently {{occupancy}}) to which type?",
    vars: ["roomNumber", "roomTypeName", "occupancy"],
    kind: "header", group: "changeType", origin: "render",
    note: "Text path. occupancy comes from occupancyPhrase, so it omits zero children and includes the extra bed.",
  },
  "changeType.listBody": {
    default: "Change Room {{roomNumber}} to which type?",
    vars: ["roomNumber"],
    kind: "body", group: "changeType", origin: "modifyLists",
    note: "Interactive path. Deliberately shorter than changeType.header and carries no occupancy — not a bug.",
  },
  "changeType.noOthers": {
    default: "Sorry, there are no other room types to switch to.",
    kind: "body", group: "changeType", origin: "handler",
  },

  // ── Plans ──────────────────────────────────────────────────────────────────

  "plans.textFallbackHeader": {
    default: "🏨 *Choose your room plan:*",
    kind: "header", group: "plans", origin: "render",
  },
  "plans.textFallbackFooter": {
    default: "Reply *1–{{count}}* to choose · *MENU* to cancel",
    vars: ["count"],
    kind: "footer", group: "plans", origin: "render",
    note: "En dash in the range.",
  },
  "plans.bedsIncluded": {
    default: "Extra beds incl.",
    kind: "fragment", group: "plans", origin: "render",
    note: "Capitalised abbreviated form, used by renderPlanTextFallback and buildPlanDescription. plans.detailBedsIncluded is the other form.",
  },
  "plans.bedsNone": {
    default: "No extra beds",
    kind: "fragment", group: "plans", origin: "render",
    note: "Capitalised form. plans.detailBedsNone is the lower-case long form.",
  },
  "plans.detailHeader": {
    default: "🏨 *Your Room Options*",
    kind: "header", group: "plans", origin: "planList",
  },
  "plans.detailFooter": {
    default: "_Tap *View Plans* to choose_ 👇",
    kind: "footer", group: "plans", origin: "planList",
  },
  "plans.detailBedsIncluded": {
    default: "extra beds included",
    kind: "fragment", group: "plans", origin: "planList",
    note: "Lower-case long form inside the plan detail body. Diverges from plans.bedsIncluded by design.",
  },
  "plans.detailBedsNone": {
    default: "no extra beds",
    kind: "fragment", group: "plans", origin: "planList",
    note: "Lower-case long form. Diverges from plans.bedsNone by design.",
  },
  "plans.sectionTitle": {
    default: "Choose a Plan",
    maxLen: 24,
    kind: "section.title", group: "plans", origin: "planList",
  },
  "plans.buttonLabel": {
    default: "View Plans",
    maxLen: 20,
    kind: "button", group: "plans", origin: "planList",
    note: "Also named inside plans.detailFooter's text — keep the two in step when rewording.",
  },
  "plans.rowTitleLegacy": {
    default: "Plan {{number}} — {{total}}",
    vars: ["number", "total"],
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "planList",
    note: "Fallback row title when a plan carries no label (legacy generatePlans output).",
  },
  "plans.typeNameFallback": {
    default: "Room",
    kind: "fragment", group: "plans", origin: "plans",
    note: "planTypeName when a plan has no rooms. buildPlanDescription has its own identical fallback.",
  },
  "plans.typeNameMix": {
    default: "{{name}} mix",
    vars: ["name"],
    kind: "fragment", group: "plans", origin: "plans",
    note: "Mixed-room-type plans.",
  },
  "plans.labelYourChoice": {
    default: "Your Choice ⭐",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.labelBestValue": {
    default: "Best Value 💰",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.labelBestExperience": {
    default: "Best Experience 🌟",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.labelBudgetFriendly": {
    default: "Budget Friendly 🤝",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.labelComfortPick": {
    default: "Comfort Pick ✨",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.labelPremiumValue": {
    default: "Premium Value ✨",
    maxLen: 24,
    kind: "row.title", group: "plans", origin: "plans",
  },
  "plans.rationaleYourChoiceOne": {
    default: "{{count}} {{roomTypeName}} room as requested",
    vars: ["count", "roomTypeName"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
    note: "roomCount === 1 arm.",
  },
  "plans.rationaleYourChoiceMany": {
    default: "{{count}} {{roomTypeName}} rooms as requested",
    vars: ["count", "roomTypeName"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
    note: "roomCount > 1 arm.",
  },
  "plans.rationaleYourChoiceFallback": {
    default: "Includes your preferred {{roomTypeName}}",
    vars: ["roomTypeName"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
    note: "Used when preferred-only cannot house the party and the mixed fallback is taken.",
  },
  "plans.rationaleBestValue": {
    default: "Fewest rooms — best rate at {{total}}",
    vars: ["total"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
  },
  "plans.rationaleBestExperience": {
    default: "Most spacious — {{typeName}} throughout",
    vars: ["typeName"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
  },
  "plans.rationaleBudgetFriendly": {
    default: "Best rate — all {{roomTypeName}}",
    vars: ["roomTypeName"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
  },
  "plans.rationaleComfortPickOne": {
    default: "{{count}} room, base occupancy",
    vars: ["count"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
    note: "roomCount === 1 arm.",
  },
  "plans.rationaleComfortPickMany": {
    default: "{{count}} rooms, base occupancy",
    vars: ["count"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
    note: "roomCount > 1 arm.",
  },
  "plans.rationalePremiumValue": {
    default: "{{typeName}} — {{total}}",
    vars: ["typeName", "total"],
    maxLen: 72,
    kind: "row.desc", group: "plans", origin: "plans",
  },

  // ── Room-type descriptions ─────────────────────────────────────────────────

  "rooms.descHeader": {
    default: "🏨 *Our Room Types*",
    kind: "header", group: "rooms", origin: "render",
  },
  "rooms.descFooter": {
    default: "_Tap the options below to choose your preferred room type_ 👇",
    kind: "footer", group: "rooms", origin: "render",
  },

  // ── Interactive list chrome ────────────────────────────────────────────────

  "lists.modifyRoomSection": {
    default: "Modify Room",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.navigationSection": {
    default: "Navigation",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
    note: "Reused by the room-menu, move-to-room and change-type lists.",
  },
  "lists.goBackRow": {
    default: "↩️ Go back",
    maxLen: 24,
    kind: "row.title", group: "lists", origin: "modifyLists",
    note: "Title only; the four go-back ids (MOD_/MOVE_/MODIFY_/CHANGE_TYPE_GO_BACK) are wire protocol.",
  },
  "lists.availableRoomsSection": {
    default: "Available Rooms",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.editExistingSection": {
    default: "Edit Existing Rooms",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.addRoomSection": {
    default: "Add a Room",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.confirmSection": {
    default: "Confirm",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.confirmBookingRow": {
    default: "✅ Confirm booking",
    maxLen: 24,
    kind: "row.title", group: "lists", origin: "modifyLists",
  },
  "lists.availableTypesSection": {
    default: "Available Room Types",
    maxLen: 24,
    kind: "section.title", group: "lists", origin: "modifyLists",
  },
  "lists.cancelFooter": {
    default: "Type 'Hi' to cancel",
    kind: "footer", group: "lists", origin: "modifyLists",
    note: "KNOWN WRONG, PRESERVED: the node matches MENU/CANCEL_BOOKING and never 'Hi'. Emitted by all four modifyLists senders. Pinned by goldens so fixing it is a visible diff. Do not correct in Stage 1.",
  },
  "lists.buttonOptions": {
    default: "Options",
    maxLen: 20,
    kind: "button", group: "lists", origin: "modifyLists",
    note: "Shares its default with flowRuntime.mixButton — two independent senders that happen to agree.",
  },
  "lists.buttonChooseRoom": {
    default: "Choose Room",
    maxLen: 20,
    kind: "button", group: "lists", origin: "modifyLists",
  },
  "lists.buttonChooseType": {
    default: "Choose Type",
    maxLen: 20,
    kind: "button", group: "lists", origin: "modifyLists",
  },
  "lists.buttonEditBooking": {
    default: "Edit Booking",
    maxLen: 20,
    kind: "button", group: "lists", origin: "modifyLists",
  },

  // ── Rejection reasons (pure appliers; never thrown) ────────────────────────

  "rejections.noExtraBed": {
    default: "{{roomTypeName}} rooms don't support an extra bed.",
    vars: ["roomTypeName"],
    kind: "body", group: "rejections", origin: "appliers",
    note: "Emitted by applyAddExtraBed and applyMoveExtraBed with identical text.",
  },
  "rejections.nothingToMove": {
    default: "Nothing to move.",
    kind: "body", group: "rejections", origin: "appliers",
  },
  "rejections.sourceLacksGuests": {
    default: "Room {{roomNumber}} only has {{adultsPhrase}} and {{childrenPhrase}}.",
    vars: ["roomNumber", "adultsPhrase", "childrenPhrase"],
    kind: "body", group: "rejections", origin: "appliers",
    note: "Both phrases are pre-built in TS so pluralisation stays in code.",
  },
  "rejections.maxAdults": {
    default: "{{roomTypeName}} rooms hold at most {{adultsPhrase}}.",
    vars: ["roomTypeName", "adultsPhrase"],
    kind: "body", group: "rejections", origin: "appliers",
    note: "Emitted by applyMoveGuest and applyChangeRoomType with identical text.",
  },
  "rejections.maxChildren": {
    default: "{{roomTypeName}} rooms hold at most {{childrenPhrase}}.",
    vars: ["roomTypeName", "childrenPhrase"],
    kind: "body", group: "rejections", origin: "appliers",
    note: "Emitted by applyMoveGuest and applyChangeRoomType with identical text.",
  },
  "rejections.typeUnavailable": {
    default: "Sorry, no {{roomTypeName}} rooms are available for those dates.",
    vars: ["roomTypeName"],
    kind: "body", group: "rejections", origin: "appliers",
  },
  "rejections.genericAction": {
    default: "Sorry, that didn't work. Please choose another option.",
    kind: "body", group: "rejections", origin: "handler",
    note: "Only when an applier rejects with an empty reason.",
  },
  "rejections.noMoreOfType": {
    default: "Sorry, no more *{{roomTypeName}}* rooms available for those dates. Please pick another.",
    vars: ["roomTypeName"],
    kind: "body", group: "rejections", origin: "handler",
  },
  "rejections.cannotTakeRemaining": {
    default: "Sorry, *{{roomTypeName}}* can't take your remaining guests. Please pick another.",
    vars: ["roomTypeName"],
    kind: "body", group: "rejections", origin: "handler",
  },

  // ── flowRuntime-side senders ───────────────────────────────────────────────
  // These senders are module-private in flowRuntime.ts and their strings are
  // inline literals interleaved with prisma + sendOutbound calls, so they can
  // only be verified by source scan — see the header of copy.test.ts.

  "flowRuntime.carouselBody": {
    default: "🏨 *Choose a room type:*",
    kind: "body", group: "preference", origin: "flowRuntime",
  },
  "flowRuntime.carouselButton": {
    default: "Choose",
    maxLen: 20,
    kind: "button", group: "preference", origin: "flowRuntime",
    note: "Per-card quick-reply label. Its id room_TYPE:{id} is wire protocol.",
  },
  "flowRuntime.mixBody": {
    default: "_Not sure? Let us pick the best combination for you_ 👇",
    kind: "body", group: "preference", origin: "flowRuntime",
    note: "Interactive variant. The no-dep text fallback is preference.mixTextFallback, which says MIX instead.",
  },
  "flowRuntime.mixButton": {
    default: "Options",
    maxLen: 20,
    kind: "button", group: "preference", origin: "flowRuntime",
    note: "Shares its default with lists.buttonOptions — two independent senders that happen to agree.",
  },
  "flowRuntime.mixSection": {
    default: "Let us choose",
    maxLen: 24,
    kind: "section.title", group: "preference", origin: "flowRuntime",
  },
  "flowRuntime.mixRowTitle": {
    default: "Mix it up 🎲",
    maxLen: 24,
    kind: "row.title", group: "preference", origin: "flowRuntime",
    note: "Title only. Its id MIX_IT_UP is wire protocol.",
  },
  "flowRuntime.mixRowDesc": {
    default: "We'll pick the best room combination",
    maxLen: 72,
    kind: "row.desc", group: "preference", origin: "flowRuntime",
  },

  // ── Stage 1.1 — interactive row templates (audit F1) ───────────────────────
  // Guest-visible row titles and descriptions that the first pass goldened but
  // never keyed. Belong to the `lists` / `move` groups above; kept in one block
  // so the coverage patch is reviewable in isolation.

  "lists.editRoomTitle": {
    default: "Edit Room {{roomNumber}}: {{roomTypeName}}",
    vars: ["roomNumber", "roomTypeName"],
    maxLen: 24,
    kind: "row.title", group: "lists", origin: "modifyLists",
    note: "Manual-mode edit row. Sliced to 24 at the call site, so a long room name is cut mid-word.",
  },
  "lists.editRoomDesc": {
    default: "{{occupancy}} — {{total}}",
    vars: ["occupancy", "total"],
    maxLen: 72,
    kind: "row.desc", group: "lists", origin: "modifyLists",
    note: "occupancy comes from occupancyLabel, which ALWAYS prints the children clause and NEVER the extra bed — unlike occupancyPhrase on the text path. See copy.golden.test.ts.",
  },
  "lists.addRoomDesc": {
    default: "Fits {{maxAdults}} adults, {{maxChildren}} children · {{price}}/night · {{available}} avail",
    vars: ["maxAdults", "maxChildren", "available", "price"],
    maxLen: 72,
    kind: "row.desc", group: "lists", origin: "modifyLists",
    note: "Never pluralises: renders '1 children'. A null cap renders '?' — that fallback is still unkeyed.",
  },
  "lists.moveToRoomDesc": {
    default: "Currently {{adults}} adults, {{children}} children (max {{maxAdults}} adults, {{maxChildren}} children)",
    vars: ["adults", "children", "maxAdults", "maxChildren"],
    maxLen: 72,
    kind: "row.desc", group: "lists", origin: "modifyLists",
    note: "Occupancy renderer #5. Capital 'Currently' and always-plural, so it disagrees with move.toRoomRow on the same screen.",
  },
  "lists.changeTypeDesc": {
    default: "{{price}}/night · {{available}} available",
    vars: ["price", "available"],
    maxLen: 72,
    kind: "row.desc", group: "lists", origin: "modifyLists",
    note: "Says 'available' in full, where lists.addRoomDesc abbreviates to 'avail'.",
  },
  "move.toRoomRow": {
    default: "*{{number}}.* {{roomTypeName}} — currently {{adults}} adults, {{children}} child (max {{maxAdults}} adults, {{maxChildren}} child)",
    vars: ["number", "roomTypeName", "adults", "children", "maxAdults", "maxChildren"],
    kind: "fragment", group: "move", origin: "render",
    note: "Occupancy renderer #4. Pluralises NOTHING — always 'adults' and always 'child', so '1 adults' and '2 child' both occur. No Meta cap: this is text, not a list row.",
  },

  // ── Stage 1.1 — room-type carousel card copy (audit F2) ────────────────────
  // The only guest-facing ARA strings the first pass left both unkeyed AND
  // ungoldened. They live in flowRuntime's private trySendRoomTypeCarousel, so
  // they are source-scanned here and composed (not called) in the goldens.

  "flowRuntime.cardCapWithChildren": {
    default: "Up to {{maxAdults}} adults, {{maxChildren}} children",
    vars: ["maxAdults", "maxChildren"],
    kind: "fragment", group: "preference", origin: "flowRuntime",
    note: "maxChildren > 0 arm of the carousel card capacity line.",
  },
  "flowRuntime.cardCapAdultsOnly": {
    default: "Up to {{maxAdults}} adults",
    vars: ["maxAdults"],
    kind: "fragment", group: "preference", origin: "flowRuntime",
    note: "maxChildren === 0 arm. Never pluralised, so '1 adults' occurs.",
  },
  "flowRuntime.cardDescription": {
    default: "{{cap}} · {{price}}/night",
    vars: ["cap", "price"],
    maxLen: 60,
    kind: "row.desc", group: "preference", origin: "flowRuntime",
    note: "cap is one of the two cardCap* arms. Sliced to 60 at the call site; the price uses the NON-rounding formatter.",
  },


} as const satisfies Record<string, AraCopySpec>;

// ── Derived types + defaults ──────────────────────────────────────────────────

export type AraCopyKey = keyof typeof ARA_COPY;

/** A complete, resolved copy bundle. Total over AraCopyKey by construction, so
 *  a lookup can never be undefined at a call site. */
export type AraCopy = Readonly<Record<AraCopyKey, string>>;

/** Every key at its built-in default. The wiring stage layers hotel overrides
 *  on top of this; Stage 1 ships it as the only bundle that exists. */
export const DEFAULT_COPY: AraCopy = Object.freeze(
  Object.fromEntries(
    (Object.keys(ARA_COPY) as AraCopyKey[]).map((k) => [k, ARA_COPY[k].default]),
  ) as Record<AraCopyKey, string>,
);

// ── Interpolation ─────────────────────────────────────────────────────────────

/**
 * Substitute `{{token}}` placeholders. Delegates to the node's existing
 * `interpolate` so there is exactly ONE interpolation implementation in the
 * codebase — including its deliberate contract that an unknown token is left
 * verbatim as `{{token}}` rather than blanked, so an authoring mistake is
 * visible instead of silently producing a gap.
 */
export function fill(template: string, locals?: Record<string, string | number>): string {
  if (!locals) return interpolate(template, {});
  const asStrings: Record<string, string> = {};
  for (const [k, v] of Object.entries(locals)) asStrings[k] = String(v);
  return interpolate(template, asStrings);
}

/** Convenience reader for a key at its default, with optional locals. */
export function copyDefault(key: AraCopyKey, locals?: Record<string, string | number>): string {
  return fill(ARA_COPY[key].default, locals);
}

// ── Length validation (pure; nothing calls it at runtime yet) ────────────────

/** One key whose RESOLVED text exceeds the Meta cap its spec declares. */
export interface CopyLengthViolation {
  readonly key:    AraCopyKey;
  readonly kind:   AraCopyKind;
  readonly maxLen: number;
  readonly length: number;
  readonly value:  string;
}

/**
 * Kinds whose declared `maxLen` is a HARD Meta limit on the final string, where
 * overflow means a 400 and a message the guest never receives.
 *
 * Row titles and descriptions are excluded on purpose: the call sites already
 * `.slice()` those, so overflow is truncated rather than rejected. Buttons and
 * section titles are NOT sliced anywhere today (audit F5), which is exactly why
 * they need checking before any override can reach them.
 */
export const HARD_CAP_KINDS: readonly AraCopyKind[] = ["button", "section.title"];

/**
 * Check an already-resolved (post-interpolation) copy bundle against the caps
 * its specs declare. Pure: no I/O, no throwing, no mutation — it reports and
 * lets the caller decide.
 *
 * This is the gate the wiring stage should run over a hotel's overrides BEFORE
 * accepting them. It deliberately does NOT truncate: silently shortening a
 * hotel's button label is how you ship a button that reads "Confirm boo".
 *
 * Pass only the keys you want checked; absent keys are skipped, so a partial
 * override map can be validated on its own.
 */
export function validateResolvedCopy(
  resolved: Partial<Record<AraCopyKey, string>>,
  opts?: { onlyKinds?: readonly AraCopyKind[] },
): CopyLengthViolation[] {
  const out: CopyLengthViolation[] = [];
  for (const [key, value] of Object.entries(resolved) as [AraCopyKey, string | undefined][]) {
    if (value === undefined) continue;
    const spec = ARA_COPY[key] as AraCopySpec | undefined;
    if (!spec || spec.maxLen === undefined) continue;
    if (opts?.onlyKinds && !opts.onlyKinds.includes(spec.kind)) continue;
    if (value.length > spec.maxLen) {
      out.push({ key, kind: spec.kind, maxLen: spec.maxLen, length: value.length, value });
    }
  }
  return out;
}

/**
 * Keys whose resolved text is knowable from the registry alone, because they
 * declare no `{{vars}}`. Every `button` and `section.title` key is in this set
 * today, which is what makes `validateResolvedCopy(DEFAULT_COPY)` a complete
 * check for those kinds rather than a sample. `copy.test.ts` asserts that
 * property, so adding a templated button would fail loudly instead of quietly
 * creating an unvalidatable cap.
 */
export function staticKeys(): AraCopyKey[] {
  return (Object.keys(ARA_COPY) as AraCopyKey[]).filter((k) => !(ARA_COPY[k] as AraCopySpec).vars?.length);
}
