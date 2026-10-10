/**
 * ara/phases/confirm.phase.ts — the confirm step, finalisation, and the
 * phase-aware AI free-text fallback.
 *
 * `tryModify` returns null ONLY when there is no interpreter dep, so every
 * caller keeps its exact pre-AI behaviour. The AI chooses an operation and
 * indices; this module validates and prices everything deterministically.
 */

import { computeRoomPricing, resolveRoomConfig } from "../allocator";
import {
  applyAddExtraBed,
  applyMoveExtraBed,
  applyMoveGuest,
  applyRemoveExtraBed,
  applyRemoveRoom,
} from "../appliers";
import { resolveConfig } from "../config";
import { MODIFY_FAILED, MODIFY_PROMPT } from "../constants";
import { confirmPromptFooter, renderAllocationSummary } from "../render";
import {
  clearState,
  persist,
  readState,
  writeOutputContract,
  writeState,
} from "../state";
import type {
  AdvancedRoomAllocationDeps,
  AdvancedRoomAllocationNodeData,
  AllocationRoom,
  AllocationRoomInput,
  ApplyResult,
  AraState,
  ModifyPhase,
  RoomConfigResolver,
} from "../types";

/**
 * Confirm-step reply: when a button sender is injected, send the allocation
 * summary (WITHOUT the text footer) as an interactive 3-button message and
 * return "ALREADY_SENT". Otherwise return the legacy text summary with the
 * reply-instructions footer (full back-compat — tests with no dep are unchanged).
 */
export async function confirmReply(
  deps: AdvancedRoomAllocationDeps,
  rooms: AllocationRoom[],
  childrenAges: number[] | undefined,
): Promise<string> {
  if (deps.sendConfirmButtons) {
    const bodyText = renderAllocationSummary(rooms, { childrenAges }); // no text footer — buttons replace it
    const sent = await deps.sendConfirmButtons({ hotelId: deps.hotelId, guestId: deps.guestId, bodyText });
    if (sent) return "ALREADY_SENT";
  }
  return renderAllocationSummary(rooms, { trailing: confirmPromptFooter(), childrenAges });
}

export async function finalizeAndAdvance(deps: AdvancedRoomAllocationDeps, allocated: AllocationRoom[]): Promise<string | null> {
  const { flowData, currentNodeId, adjacency, nextNodeId, advance, guestId, hotelId, resetSession, safeMenu } = deps;
  // Output contract write is guarded by !bookingRooms inside writeOutputContract.
  const wrote = writeOutputContract(flowData.flowVars, allocated);
  // Piece 2E — selectedPlanType from the (pre-clear) state. preferredRoomTypeId +
  // planCount were already written when the plan list was generated. Only write on
  // the first finalize (same idempotency window as the output contract).
  if (wrote) {
    const st = readState(flowData.flowVars);
    if (st?.selectedPlanType) flowData.flowVars["selectedPlanType"] = st.selectedPlanType;
  }
  clearState(flowData.flowVars);
  delete flowData.waitingFor;

  const next = nextNodeId(currentNodeId, adjacency);
  if (!next) {
    // No downstream node — booking can't progress. Best-effort: reset and show menu.
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId, guestId);
  }
  // Don't persist here — the recursive advance call will re-save under the
  // new node's state. Persisting twice would race with the downstream save.
  return advance(next);
}

// ── Manual-mode AI fallback ───────────────────────────────────────────────────

/** Render the allocation followed by the prompt for the current phase. */
export function renderWithPrompt(phase: ModifyPhase, st: AraState): string {
  if (phase === "confirm") {
    return renderAllocationSummary(st.selectedRooms, { trailing: confirmPromptFooter(), childrenAges: st.guests.childrenAges });
  }
  return `${renderAllocationSummary(st.selectedRooms, { childrenAges: st.guests.childrenAges })}\n\n${MODIFY_PROMPT}`;
}

/** The phase's existing (no-change) re-prompt — what the guest sees when nothing was applied. */
export function existingReprompt(phase: ModifyPhase, st: AraState, roomInputs: AllocationRoomInput[]): string {
  if (phase === "confirm") {
    return `Please reply *1* to confirm, *2* to modify, or *MENU* to cancel.\n\n${renderAllocationSummary(st.selectedRooms, { childrenAges: st.guests.childrenAges })}`;
  }
  return `Please reply with a room number (1–${roomInputs.length}), *DONE* to finish, or *MENU* to cancel.`;
}

/**
 * Phase-aware fallback for free text that structured parsing couldn't match.
 * Runs in BOTH confirm and manual phases. Returns the reply string, or `null`
 * ONLY when there is no interpreter dep (caller keeps its exact current
 * behaviour). The AI only chooses an operation + indices + counts; this
 * function validates everything, applies the change deterministically (prices
 * recomputed here, never by the AI), persists with the SAME phase, and
 * re-renders. On unknown / low-confidence / out-of-range it acknowledges the
 * miss and re-prompts — it never silently guesses or applies.
 */
export async function tryModify(
  deps:       AdvancedRoomAllocationDeps,
  state:      AraState,
  roomInputs: AllocationRoomInput[],
  input:      string,
  phase:      ModifyPhase,
): Promise<string | null> {
  if (!deps.interpretModification) return null;

  const currentRooms = state.selectedRooms.map((r, index) => ({
    index,
    roomTypeName: r.roomTypeName,
    adults:       r.adults,
    children:     r.children,
    extraBed:     r.extraBed,
  }));

  const ai = await deps.interpretModification(currentRooms, input);

  // Acknowledge + re-prompt without changing anything (Fix A).
  const ackReprompt = (): string => `${MODIFY_FAILED}\n\n${existingReprompt(phase, state, roomInputs)}`;

  // Never guess.
  if (ai.operation === "unknown" || ai.confidence === "low") return ackReprompt();

  // Per-room config resolver from live inventory (DB overrides → node config).
  const nodeConfig = resolveConfig((deps.node.data ?? {}) as AdvancedRoomAllocationNodeData);
  const inputById  = new Map(roomInputs.map((ri) => [ri.roomTypeId, ri]));
  const resolveCfg: RoomConfigResolver = (ar) => {
    const ri = inputById.get(ar.roomTypeId);
    return ri ? resolveRoomConfig(ri, nodeConfig) : nodeConfig;
  };

  let applied: ApplyResult;
  switch (ai.operation) {
    case "add_extra_bed":
      applied = applyAddExtraBed(state.selectedRooms, ai.roomIndex ?? -1, resolveCfg);
      break;
    case "remove_extra_bed":
      applied = applyRemoveExtraBed(state.selectedRooms, ai.roomIndex ?? -1);
      break;
    case "move_extra_bed":
      applied = applyMoveExtraBed(state.selectedRooms, ai.fromRoomIndex ?? -1, ai.toRoomIndex ?? -1, resolveCfg);
      break;
    case "remove_room":
      applied = applyRemoveRoom(state.selectedRooms, ai.roomIndex ?? -1);
      break;
    case "move_guest":
      applied = applyMoveGuest(
        state.selectedRooms, ai.fromRoomIndex ?? -1, ai.toRoomIndex ?? -1, ai.adults ?? 0, ai.children ?? 0, resolveCfg,
      );
      break;
    default:
      return ackReprompt();
  }

  if (!applied.ok) {
    // Out-of-range index behaves like "unknown" → acknowledge + re-prompt.
    if (applied.outOfRange) return ackReprompt();
    // Validation rejection (e.g. cap exceeded) → reason + unchanged allocation.
    return `${applied.reason}\n\n${renderWithPrompt(phase, state)}`;
  }

  const updated: AraState = {
    guests:        state.guests,
    selectedRooms: applied.rooms,
    remainingGuests: applied.returnedGuests
      ? {
          adults:   state.remainingGuests.adults   + applied.returnedGuests.adults,
          children: state.remainingGuests.children + applied.returnedGuests.children,
        }
      : state.remainingGuests,
    phase, // KEEP the current phase — confirm stays confirm, manual stays manual.
  };
  writeState(deps.flowData.flowVars, updated);
  await persist(deps);

  return renderWithPrompt(phase, updated);
}
