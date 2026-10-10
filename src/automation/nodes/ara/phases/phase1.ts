/**
 * ara/phases/phase1.ts — first entry into the node.
 *
 * phase1 is IDEMPOTENT: when araState already exists it re-renders rather than
 * re-running the allocator, so a webhook retry can never produce a different
 * allocation than the one the guest was shown.
 */

import { allocateRooms } from "../allocator";
import { buildOccupancyNotice, extractAgesRegex, reclassifyGuests } from "../ages";
import { resolveConfig } from "../config";
import { resolveNightsOrExplain } from "../dates";
import { buildInventoryRooms } from "../inventory";
import { generateSmartPlans } from "../plans";
import {
  buildRoomDescriptionsMessage,
  confirmPromptFooter,
  renderAllocationSummary,
  renderPlanTextFallback,
} from "../render";
import { clearState, persist, readState, writeState } from "../state";
import { confirmReply } from "./confirm.phase";
import type {
  AdvancedRoomAllocationDeps,
  AdvancedRoomAllocationNodeData,
  AllocationConfig,
  AraState,
} from "../types";

// ── Phase 1 ───────────────────────────────────────────────────────────────────

export async function phase1(deps: AdvancedRoomAllocationDeps): Promise<string | null> {
  const { node, hotelId, guestId, flowData, fetchRoomTypes, getCalendarData, resetSession } = deps;
  const vars = flowData.flowVars;
  const data = (node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data);

  // ── Idempotency guard (rule 1): if araState already exists, re-render rather
  // than re-running the allocator (would risk a different outcome if availability
  // shifted in the milliseconds between webhook retries).
  const existing = readState(vars);
  if (existing) {
    flowData.waitingFor = "answer";
    await persist(deps);
    // Mid plan-selection (webhook retry) → re-show the TEXT list, never re-send
    // the carousel (avoids a double-send).
    if (existing.phase === "plan_selection" && existing.plans && existing.plans.length > 0) {
      return renderPlanTextFallback(existing.plans);
    }
    return renderAllocationSummary(existing.selectedRooms, { trailing: confirmPromptFooter(), childrenAges: existing.guests.childrenAges });
  }

  // Date inputs are mandatory; let an earlier date question collect them.
  // A missing/reversed date re-asks that one field instead of wiping the session.
  const dates = await resolveNightsOrExplain(deps);
  if ("message" in dates) return dates.message;
  const { nights, checkIn, checkOut } = dates;

  // Guest counts come from configurable flowVars (set on the node), falling back
  // to the historical bookingAdults / bookingChildren names + "2" / "0" defaults.
  const adultsVarName   = data.adultsVar   || "bookingAdults";
  const childrenVarName = data.childrenVar || "bookingChildren";

  const adults   = parseInt(vars[adultsVarName]   ?? "2", 10) || 2;
  const children = parseInt(vars[childrenVarName] ?? "0", 10) || 0;

  if (adults + children === 0) {
    // Recoverable: re-ask the guest count rather than discarding the dates.
    if (deps.retryStep) {
      clearState(vars);
      const retried = await deps.retryStep(
        adultsVarName,
        "I need at least one guest to suggest rooms — how many people are staying?",
      );
      if (retried !== null) return retried;
    }
    await resetSession(guestId, hotelId);
    return "I need at least one guest to allocate a room. Please start over from the main menu.";
  }

  // ── Children-age collection (Task 1) ──────────────────────────────────────
  // If there are children and ages aren't already fully known, gather them
  // statefully (possibly across several messages) before allocating. Ages may be
  // pre-supplied via the configured childrenAgesVar; if that already has enough,
  // we skip collection entirely (full back-compat).
  let presetAges: number[] = [];
  const agesVarName = data.childrenAgesVar || "";
  if (agesVarName && vars[agesVarName]) {
    presetAges = extractAgesRegex(vars[agesVarName]);
  }

  if (children > 0 && presetAges.length < children) {
    // Enter stateful collection. The first prompt asks for the ages.
    const collectState: AraState = {
      guests:          { adults, children },
      selectedRooms:   [],
      remainingGuests: { adults: 0, children: 0 },
      phase:           "collecting_ages",
      ageCollection:   { adults, children, childrenCount: children, collectedAges: [], rounds: 0 },
    };
    writeState(vars, collectState);
    flowData.waitingFor = "answer";
    await persist(deps);
    return children === 1
      ? "How old is your child? 👶"
      : `Please share the ages of your ${children} children — e.g. 5, 8 and 12 👶`;
  }

  // No children, or ages already supplied → reclassify and allocate immediately.
  // Pre-supplied ages are passed through verbatim (back-compat: a count mismatch
  // is preserved, and the summary's own equal-length check decides display).
  return reclassifyAndProceed(deps, { adults, children, childrenAges: presetAges, checkIn, checkOut, nights, config });
}

/**
 * Reclassify children over the hotel age limit into adults (Task 3), optionally
 * send the occupancy notice (Task 4), then run the allocator with the EFFECTIVE
 * counts. Shared by phase1 (no-ages path) and the collecting_ages completion.
 * The base-first allocator is never touched — only its inputs.
 */
export async function reclassifyAndProceed(
  deps: AdvancedRoomAllocationDeps,
  args: { adults: number; children: number; childrenAges: number[]; checkIn: string; checkOut: string; nights: number; config: AllocationConfig },
): Promise<string | null> {
  const { hotelId, guestId, flowData } = deps;
  const vars = flowData.flowVars;
  const { adults, children, childrenAges, checkIn, checkOut, nights } = args;

  // childAgeLimit on the resolved config now comes from the injected HotelConfig
  // value (deps.childAgeLimit), falling back to node-data inside resolveConfig.
  const config = { ...args.config, childAgeLimit: deps.childAgeLimit ?? args.config.childAgeLimit };

  const { effectiveAdults, effectiveChildren, effectiveChildrenAges, promotedToAdult } =
    reclassifyGuests(adults, children, childrenAges, config.childAgeLimit);

  // Persist the four computed values as flowVars (Task 3).
  flowData.flowVars = {
    ...flowData.flowVars,
    effectiveAdults:       String(effectiveAdults),
    effectiveChildren:     String(effectiveChildren),
    effectiveChildrenAges: JSON.stringify(effectiveChildrenAges),
    promotedToAdult:       String(promotedToAdult),
  };

  // Occupancy notice (Task 4) — only when at least one child became an adult.
  if (promotedToAdult > 0 && deps.sendOccupancyNotice && config.childAgeLimit != null) {
    const text = buildOccupancyNotice(effectiveAdults, effectiveChildren, promotedToAdult, config.childAgeLimit);
    await deps.sendOccupancyNotice({ hotelId, guestId, text });
  }

  return proceedToAllocation(deps, {
    effectiveAdults,
    effectiveChildren,
    effectiveChildrenAges,
    checkIn,
    checkOut,
    nights,
    config,
  });
}

/**
 * Build inventory, generate plans, and branch into the single-summary / plan
 * list flow exactly as before — but using the EFFECTIVE (post-reclassification)
 * guest counts. The allocation algorithm itself is unchanged.
 */
export async function proceedToAllocation(
  deps: AdvancedRoomAllocationDeps,
  args: { effectiveAdults: number; effectiveChildren: number; effectiveChildrenAges: number[]; checkIn: string; checkOut: string; nights: number; config: AllocationConfig },
): Promise<string | null> {
  const { hotelId, guestId, flowData, fetchRoomTypes, getCalendarData, resetSession } = deps;
  const vars = flowData.flowVars;
  const { effectiveAdults: adults, effectiveChildren: children, effectiveChildrenAges, checkIn, checkOut, nights, config } = args;

  const roomInputs = await buildInventoryRooms(hotelId, checkIn, checkOut, fetchRoomTypes, getCalendarData);

  // Inventory-exhaustion guard: if no combination can house the party at all,
  // fail gracefully BEFORE sending the carousel (no point asking for a preference).
  const feasible = allocateRooms({ adults, children, rooms: roomInputs, config, nights });
  if (!feasible || feasible.length === 0) {
    // Recoverable: the message already invites different dates — so actually let
    // the guest supply them instead of ending the conversation.
    const soldOut =
      `Sorry, we don't have enough rooms for ${adults + children} guests on those dates. ` +
      `Try different dates and I'll check again — your other details are saved. 👍`;
    if (deps.retryStep) {
      // Drop the cached allocation first — otherwise phase1's idempotency guard
      // would re-render this same (now stale) result instead of re-allocating
      // against the guest's corrected dates.
      clearState(deps.flowData.flowVars);
      const retried = await deps.retryStep("bookingCheckIn", soldOut);
      if (retried !== null) return retried;
    }
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${adults + children} guests on those dates. Please contact us directly or try different dates.`;
  }

  const childrenAges = effectiveChildrenAges;
  const guestsField = { adults, children, ...(childrenAges.length > 0 ? { childrenAges } : {}) };
  const node = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;

  // ── Piece 2A: carousel-first preference collection. ──
  // 1D — optional room-descriptions text before the carousel.
  if (node.sendRoomDescriptions && deps.sendRoomDescriptions) {
    const descText = buildRoomDescriptionsMessage(roomInputs);
    if (descText) await deps.sendRoomDescriptions({ hotelId, guestId, text: descText });
  }

  // Enter collecting_room_preference and persist the inventory snapshot so the
  // preference handler can generate plans without re-querying.
  const prefState: AraState = {
    guests:          guestsField,
    selectedRooms:   [],
    remainingGuests: { adults: 0, children: 0 },
    phase:           "collecting_room_preference",
    prefCollection:  { adults, children, nights, rooms: roomInputs },
  };
  writeState(vars, prefState);
  flowData.waitingFor = "answer";
  await persist(deps);

  // Message: room-type carousel (cards = room types; tap sets the preference).
  if (deps.sendRoomCarousel) {
    await deps.sendRoomCarousel({ hotelId, guestId, roomInputs, adults });
  }

  // Message: "Mix it up 🎲" interactive list AFTER the carousel.
  if (deps.sendMixItUpList) {
    const sent = await deps.sendMixItUpList({ hotelId, guestId });
    if (sent) return "ALREADY_SENT";
  }
  // Text fallback (no list dep): tell the guest how to pick / mix.
  return "_Not sure? Reply *MIX* and we'll pick the best combination for you_ 🎲";
}

/**
 * Generate preference-aware plans and send the plan list (Piece 2B/2C). Shared by
 * the preference handler. Writes plan_selection state. Returns the reply string
 * ("ALREADY_SENT" when the list was dispatched, else a text fallback / error).
 */
export async function generateAndSendPlans(
  deps: AdvancedRoomAllocationDeps,
  args: {
    guestsField:          AraState["guests"];
    preferredRoomTypeId:  string | null;
    pref:                 NonNullable<AraState["prefCollection"]>;
  },
): Promise<string | null> {
  const { hotelId, guestId, flowData, resetSession } = deps;
  const vars = flowData.flowVars;
  const { guestsField, preferredRoomTypeId, pref } = args;

  const node    = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const maxPlans = typeof node.maxPlans === "number" ? node.maxPlans : 4;
  const config   = { ...resolveConfig(node), childAgeLimit: deps.childAgeLimit ?? resolveConfig(node).childAgeLimit };

  const plans = generateSmartPlans({
    adults:   pref.adults,
    children: pref.children,
    rooms:    pref.rooms,
    config,
    nights:   pref.nights,
    preferredRoomTypeId,
    maxPlans,
  });

  if (plans.length === 0) {
    const soldOut =
      `Sorry, we don't have enough rooms for ${pref.adults + pref.children} guests on those dates. ` +
      `Try different dates and I'll check again — your other details are saved. 👍`;
    if (deps.retryStep) {
      // Drop the cached allocation first — otherwise phase1's idempotency guard
      // would re-render this same (now stale) result instead of re-allocating
      // against the guest's corrected dates.
      clearState(deps.flowData.flowVars);
      const retried = await deps.retryStep("bookingCheckIn", soldOut);
      if (retried !== null) return retried;
    }
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${pref.adults + pref.children} guests on those dates. Please contact us directly or try different dates.`;
  }

  // Record the preference + plan count as flow vars (Piece 2E partial). Mutate
  // the live flowVars object in place — `vars` (and writeState below) reference
  // it, so reassigning flowData.flowVars would orphan those writes.
  vars["preferredRoomTypeId"] = preferredRoomTypeId ?? "";
  vars["planCount"]           = String(plans.length);

  // Single plan → straight to confirm (no list needed).
  if (plans.length === 1) {
    const only = plans[0]!;
    const newState: AraState = {
      guests:          guestsField,
      selectedRooms:   only.rooms,
      remainingGuests: { adults: 0, children: 0 },
      phase:           "confirm",
      preferredRoomTypeId,
      ...(only.planType ? { selectedPlanType: only.planType } : {}),
    };
    writeState(vars, newState);
    flowData.waitingFor = "answer";
    await persist(deps);
    return confirmReply(deps, only.rooms, guestsField.childrenAges);
  }

  // Multiple plans → plan_selection.
  const planState: AraState = {
    guests:          guestsField,
    selectedRooms:   [],
    remainingGuests: { adults: 0, children: 0 },
    phase:           "plan_selection",
    plans,
    eligibleRoomInputs: pref.rooms,
    preferredRoomTypeId,
  };
  writeState(vars, planState);
  flowData.waitingFor = "answer";
  await persist(deps);

  if (deps.sendPlanList) {
    const sent = await deps.sendPlanList({ hotelId, guestId, plans, eligibleRoomInputs: pref.rooms });
    if (sent) return "ALREADY_SENT";
  }
  return renderPlanTextFallback(plans);
}
