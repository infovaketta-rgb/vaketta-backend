/**
 * ara/phases/ages.phase.ts — stateful children's-age collection + read-back.
 *
 * The read-back ("confirming_ages") runs ONLY when the age set is not a literal
 * transcription of what the guest typed — the AI path was used, or the tail was
 * sliced. A bare list landing exactly on childrenCount still allocates in one turn.
 */

import {
  accumulateAges,
  ageConfirmFooter,
  extractAgesRegex,
  isBareAgeList,
  renderAgeConfirmation,
} from "../ages";
import { MAX_AGE_CORRECTIONS, MAX_AGE_ROUNDS } from "../constants";
import { resolveConfig } from "../config";
import { resolveNightsOrExplain } from "../dates";
import { isAgeConfirmInput, isAgeRejectInput } from "../keywords";
import { clearState, persist, writeState } from "../state";
import { reclassifyAndProceed } from "./phase1";
import type {
  AdvancedRoomAllocationDeps,
  AdvancedRoomAllocationNodeData,
  AraState,
} from "../types";

/**
 * Stateful children-age collection handler (Task 1). One call per guest reply.
 * Trusts the integer regex only for a bare list of ages and routes every other
 * shape to the AI parser (see isBareAgeList), accumulates across rounds,
 * guards against non-age messages, and on completion
 * (or after MAX_AGE_ROUNDS, filling the rest with 0) hands off to
 * reclassifyAndProceed. Stays in "collecting_ages" until done.
 */
export async function handleAgeCollection(deps: AdvancedRoomAllocationDeps, state: AraState): Promise<string | null> {
  const { input, flowData, hotelId, guestId, resetSession } = deps;
  const vars = flowData.flowVars;
  const ac = state.ageCollection;

  // Corrupt state guard — no working data → reset gracefully.
  if (!ac) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return "Something went wrong collecting the children's ages. Please start over from the main menu.";
  }

  const round = ac.rounds + 1;

  // Step 1 — the integer regex. Its result is only authoritative when the reply
  // is a bare list of ages; otherwise it is a starting point the AI may overrule.
  let extracted = extractAgesRegex(input);

  // Step 2 — every other shape (quantifiers, prose, embedded counts, stray
  // numbers) goes to the AI, with the expected child count as context so "all 5"
  // for 3 children can come back as [5,5,5]. Dep absent, or the AI failing /
  // returning nothing → keep the regex result, i.e. the pre-existing behaviour.
  // A non-bare reply is an uncertain reply whatever happens next: either the AI
  // interpreted it, or the AI declined and the raw regex result stands on text
  // it was never trusted to read. Both get read back before allocating.
  const aiPath = !isBareAgeList(input);
  if (aiPath && deps.extractChildrenAges) {
    try {
      const aiAges = await deps.extractChildrenAges(input, ac.childrenCount);
      if (aiAges && aiAges.length > 0) extracted = aiAges;
    } catch {
      // The injected parser is contractually non-throwing, but a dead AI
      // provider must degrade to the regex result — never take down a booking.
    }
  }

  // Step 4 — non-age message guard: nothing parsed AND no age words → re-prompt,
  // no advance. Counts as a round (so a stream of junk can't loop forever).
  if (extracted.length === 0) {
    const exhausted = round >= MAX_AGE_ROUNDS;
    if (!exhausted) {
      const next: AraState = { ...state, ageCollection: { ...ac, rounds: round, aiUsed: ac.aiUsed || aiPath } };
      writeState(vars, next);
      flowData.waitingFor = "answer";
      await persist(deps);
      return "I just need the ages of your children to continue — e.g. 5, 8 and 12 👶";
    }
    // Rounds exhausted with nothing parsed this turn → fall through to fill logic.
  }

  // Step 3 — accumulate.
  const acc = accumulateAges(ac.collectedAges, extracted, ac.childrenCount);

  if (acc.status === "complete" || acc.status === "over") {
    // Read the ages back only when the result is UNCERTAIN — i.e. it is not a
    // literal transcription of what the guest typed:
    //   • the reply went down the AI path (this round or an earlier one), so the
    //     ages were interpreted, padded, or degraded to the regex on failure; or
    //   • "over" — accumulateAges sliced the tail off, so some number the guest
    //     typed is not in the set we are about to allocate with.
    // A bare list that lands exactly on childrenCount is what the guest wrote,
    // digit for digit, and proceeds with no extra turn exactly as before.
    const uncertain = aiPath || ac.aiUsed === true || acc.status === "over";
    if (!uncertain) return finishAgeCollection(deps, ac, acc.ages);
    return askAgeConfirmation(deps, state, ac, acc.ages);
  }

  // status === "partial"
  if (round >= MAX_AGE_ROUNDS) {
    // Max rounds reached — fill remaining slots with 0 (a 0-year-old is a child
    // under any reasonable age limit) and proceed.
    const filled = [...acc.ages];
    while (filled.length < ac.childrenCount) filled.push(0);
    return finishAgeCollection(deps, ac, filled);
  }

  // Ask for the remaining ages, staying in the collection phase.
  const remaining = ac.childrenCount - acc.ages.length;
  const next: AraState = {
    ...state,
    ageCollection: { ...ac, collectedAges: acc.ages, rounds: round, aiUsed: ac.aiUsed || aiPath },
  };
  writeState(vars, next);
  flowData.waitingFor = "answer";
  await persist(deps);
  return (
    `Got ${acc.ages.join(", ")} — what's the age of your other ${remaining} ` +
    `${remaining === 1 ? "child" : "children"}?`
  );
}
/**
 * Read the collected ages back and wait for a yes/no. Enters "confirming_ages"
 * carrying the exact ages we would otherwise have allocated with, so confirming
 * costs nothing but a turn and rejecting cannot lose them.
 *
 * Reuses the existing sendConfirmButtons dep (the same 3-button sender the
 * allocation summary uses) — no new messaging path. Absent → plain text.
 */
export async function askAgeConfirmation(
  deps:  AdvancedRoomAllocationDeps,
  state: AraState,
  ac:    NonNullable<AraState["ageCollection"]>,
  ages:  number[],
): Promise<string | null> {
  const { hotelId, guestId, flowData } = deps;
  const vars = flowData.flowVars;

  const next: AraState = {
    ...state,
    phase:         "confirming_ages",
    ageCollection: { ...ac, collectedAges: ages },
    ageConfirm:    { ages, corrections: state.ageConfirm?.corrections ?? 0 },
  };
  writeState(vars, next);
  flowData.waitingFor = "answer";
  await persist(deps);

  const bodyText = renderAgeConfirmation(ages);
  if (deps.sendConfirmButtons) {
    const sent = await deps.sendConfirmButtons({ hotelId, guestId, bodyText });
    if (sent) return "ALREADY_SENT";
  }
  return `${bodyText}\n\n${ageConfirmFooter()}`;
}

/**
 * One guest reply to the age read-back. Confirm → allocate with exactly those
 * ages. Reject → clear them and ask for a plain list, ONCE; a second rejection
 * proceeds with what we have, so this can never become a loop.
 */
export async function handleAgeConfirmation(
  deps:  AdvancedRoomAllocationDeps,
  state: AraState,
): Promise<string | null> {
  const { input, flowData } = deps;
  const vars = flowData.flowVars;
  const ac      = state.ageCollection;
  const pending = state.ageConfirm;

  // Sessions serialised before this sub-phase existed (or a truncated blob) have
  // no ages to confirm. Don't throw and don't invent an answer — hand the turn
  // back to the collection handler, which is exactly where such a state was
  // headed before this phase existed.
  if (!ac || !pending) {
    const back: AraState = { ...state, phase: "collecting_ages" };
    writeState(vars, back);
    return handleAgeCollection(deps, back);
  }

  if (isAgeConfirmInput(input)) {
    return finishAgeCollection(deps, ac, pending.ages);
  }

  if (isAgeRejectInput(input)) {
    // Budget spent — proceed with what we have rather than asking again. This is
    // the pre-echo behaviour, so the worst case is exactly the old worst case.
    if (pending.corrections >= MAX_AGE_CORRECTIONS) {
      return finishAgeCollection(deps, ac, pending.ages);
    }
    const next: AraState = {
      ...state,
      phase:         "collecting_ages",
      ageCollection: { ...ac, collectedAges: [], aiUsed: false },
      ageConfirm:    { ages: pending.ages, corrections: pending.corrections + 1 },
    };
    writeState(vars, next);
    flowData.waitingFor = "answer";
    await persist(deps);
    return "No problem — please send the ages as a plain list, oldest first, e.g. *12, 8, 5* 👶";
  }

  // Anything else: re-show the question. Does not spend the correction budget
  // and does not advance — an unparsed reply is not a rejection.
  flowData.waitingFor = "answer";
  await persist(deps);
  return `${renderAgeConfirmation(pending.ages)}\n\n${ageConfirmFooter()}`;
}

/**
 * Ages are finalized — recompute dates/config and run reclassification + allocation.
 */
export async function finishAgeCollection(
  deps: AdvancedRoomAllocationDeps,
  ac:   NonNullable<AraState["ageCollection"]>,
  childrenAges: number[],
): Promise<string | null> {
  const { node, hotelId, guestId, flowData, resetSession } = deps;
  const vars = flowData.flowVars;
  const data = (node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data, deps.childAgeLimit);

  const dates = await resolveNightsOrExplain(deps);
  if ("message" in dates) return dates.message;
  const { nights, checkIn, checkOut } = dates;

  return reclassifyAndProceed(deps, {
    adults:   ac.adults,
    children: ac.children,
    childrenAges,
    checkIn,
    checkOut,
    nights,
    config,
  });
}
