/**
 * stepRetry.ts
 *
 * Step-level retry for recoverable guest input errors.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * The flow engine had exactly two outcomes for a failed validation: advance, or
 * `resetSession` + "Please start over from the main menu." A guest who typed one
 * bad check-out date lost their name, their check-in, their room choice, and
 * every age they'd just entered — then had to re-enter all of it. That is a
 * total loss of state for a single recoverable typo.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Rewind to the NODE THAT COLLECTED the offending variable, clear just that one
 * value, and re-prompt. Everything else in flowVars survives untouched.
 *
 * The rewind target is resolved from the flow graph itself via `indexVarProducers`
 * — each collecting node already declares the variable it writes (`variableName`),
 * so provenance is derivable and needs no new per-node config, no hardcoded field
 * list, and no duplicated validation. Adding a new question node to a flow makes
 * it retryable automatically.
 *
 * Kept dependency-free — imports NOTHING — so it unit-tests without flowRuntime's
 * Redis/Prisma/AI load chain. Mirrors guestDate.ts / stayDuration.ts.
 *
 * ── Channel-agnostic by construction ────────────────────────────────────────
 * Nothing here touches a channel. The engine passes `channel` opaquely and the
 * outbound pipeline (sendOutbound) picks the renderer, so a retry prompt reaches
 * WhatsApp, Instagram, and any future channel through the exact same path as the
 * node's original prompt. There is no per-channel branch to keep in sync.
 */

/** Minimal shape of a flow node needed to resolve variable provenance. */
export interface IndexableNode {
  id: string;
  type?: string;
  data?: Record<string, unknown> | null;
}

/** Node types that collect a guest answer and can therefore be re-prompted. */
const COLLECTING_NODE_TYPES = new Set([
  "question",
  "options",
  "show_rooms",
]);

/**
 * Variables a `show_rooms` / `room_selection` node writes are derived from its
 * `variableName` PREFIX (e.g. "booking" → bookingTypeId/bookingTypeName/…), plus
 * the canonical aliases. Rewinding any of them means re-running the room picker.
 */
const ROOM_SUFFIXES = ["TypeId", "TypeName", "Price"] as const;

const ROOM_CANONICAL_VARS = [
  "bookingRoomTypeId",
  "bookingRoomTypeName",
  "bookingPricePerNight",
] as const;

/** Canonical date aliases the date-question branch mirrors its answer into. */
const DATE_ALIASES: Record<string, readonly string[]> = {
  bookingCheckIn: ["checkin", "check_in", "checkIn"],
  bookingCheckOut: ["checkout", "check_out", "checkOut"],
};

/**
 * Map every guest-collected variable name → the id of the node that produced it.
 *
 * Later nodes win on collision: if two nodes write the same variable, the one
 * further along the flow is the more recent writer, and re-asking the earlier
 * one would strand the guest behind work they already completed. Node order in
 * the published `nodes` array is the flow's authoring order, which is the best
 * available proxy for "later" without walking every edge.
 */
export function indexVarProducers(nodes: readonly IndexableNode[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const node of nodes) {
    const type = node.type ?? "";
    if (!COLLECTING_NODE_TYPES.has(type)) continue;

    const data = (node.data ?? {}) as Record<string, unknown>;
    const varName = typeof data.variableName === "string" ? data.variableName.trim() : "";
    if (!varName) continue;

    if (type === "show_rooms" || data.questionType === "room_selection") {
      for (const suffix of ROOM_SUFFIXES) index.set(`${varName}${suffix}`, node.id);
      for (const canonical of ROOM_CANONICAL_VARS) index.set(canonical, node.id);
      continue;
    }

    index.set(varName, node.id);

    // A date question also mirrors its answer into bookingCheckIn/bookingCheckOut.
    // Register those aliases so a downstream date failure rewinds here.
    if (data.questionType === "date") {
      const lower = varName.toLowerCase();
      for (const [alias, markers] of Object.entries(DATE_ALIASES)) {
        if (markers.some((m) => lower.includes(m.toLowerCase()))) index.set(alias, node.id);
      }
    }
  }

  return index;
}

/** Everything the engine needs to perform one rewind. */
export interface RetryPlan {
  /** Node to re-enter — the one that originally collected `variable`. */
  nodeId: string;
  /** The variable being re-asked. */
  variable: string;
  /** flowVars with the offending value (and its aliases) removed. */
  flowVars: Record<string, string>;
  /** Message to send before the node re-prompts. */
  message: string;
}

/**
 * Build a rewind plan for `variable`, or null when no producing node is known
 * (an unmapped variable must fall back to the caller's existing behaviour rather
 * than rewinding somewhere arbitrary).
 */
export function planRetry(
  variable: string,
  flowVars: Record<string, string>,
  producers: ReadonlyMap<string, string>,
  message: string,
): RetryPlan | null {
  const nodeId = producers.get(variable);
  if (!nodeId) return null;

  // Clear the bad value AND every other variable the same node produced —
  // otherwise a room re-pick would leave a stale price from the old choice.
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(flowVars)) {
    if (producers.get(k) === nodeId) continue;
    next[k] = v;
  }

  return { nodeId, variable, flowVars: next, message };
}

/**
 * Pick which of two dates to re-ask when check-out <= check-in.
 *
 * Check-out is the later answer and overwhelmingly the one the guest got wrong
 * (they typed the wrong month, or repeated the check-in date), so it is the
 * default. If check-out has no producing node but check-in does, re-ask check-in
 * instead — better to re-ask the wrong field than to destroy the session.
 * Returns null when neither is rewindable.
 */
export function chooseDateFieldToRetry(
  producers: ReadonlyMap<string, string>,
  checkInVar = "bookingCheckIn",
  checkOutVar = "bookingCheckOut",
): string | null {
  if (producers.has(checkOutVar)) return checkOutVar;
  if (producers.has(checkInVar)) return checkInVar;
  return null;
}

// ── Retry-attempt accounting ─────────────────────────────────────────────────

/**
 * A guest can loop on a step forever if they keep sending unparseable input, and
 * each loop may cost an AI call. Cap the retries per variable, then fall back to
 * the old reset-and-restart so there is always a terminal state.
 */
export const MAX_STEP_RETRIES = 3;

/** flowVars key holding the retry tally for `variable`. Internal namespace. */
export function retryCountKey(variable: string): string {
  return `__retry_${variable}__`;
}

export function getRetryCount(flowVars: Record<string, string>, variable: string): number {
  const raw = flowVars[retryCountKey(variable)];
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True once the guest has burned every retry for this variable. */
export function retriesExhausted(flowVars: Record<string, string>, variable: string): boolean {
  return getRetryCount(flowVars, variable) >= MAX_STEP_RETRIES;
}

/** Returns flowVars with the tally for `variable` incremented by one. */
export function bumpRetryCount(
  flowVars: Record<string, string>,
  variable: string,
): Record<string, string> {
  return {
    ...flowVars,
    [retryCountKey(variable)]: String(getRetryCount(flowVars, variable) + 1),
  };
}

/**
 * Drop the tally for `variable` — called once the step finally succeeds, so a
 * guest who fixes a date and later returns to the same step gets a full budget
 * again rather than an exhausted one.
 */
export function clearRetryCount(
  flowVars: Record<string, string>,
  variable: string,
): Record<string, string> {
  const key = retryCountKey(variable);
  if (!(key in flowVars)) return flowVars;
  const next = { ...flowVars };
  delete next[key];
  return next;
}

/** Strip every retry bookkeeping key — used before a booking is finalised. */
export function clearAllRetryCounts(
  flowVars: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(flowVars)) {
    if (k.startsWith("__retry_") && k.endsWith("__")) continue;
    next[k] = v;
  }
  return next;
}
