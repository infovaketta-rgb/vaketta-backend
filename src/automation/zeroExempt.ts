import type { SessionData } from "../services/session.service";

// ARA phases where "0" means "go back" within the modification flow — NOT main menu.
export const ARA_ZERO_EXEMPT_PHASES = new Set([
  "room_menu", "move_to_room", "change_type_select", "move_from_count",
]);

/**
 * Returns true when the session is in a context where "0" must NOT trigger
 * the global main-menu reset:
 *  • Inside an ARA node in a modification phase (go-back means go-back)
 *  • Inside any question node awaiting a numeric answer ("0 children" is valid)
 */
export function isZeroExempt(sessionState: string, data: SessionData): boolean {
  if (!sessionState.startsWith("FLOW:")) return false;
  const flowVars = data.flow?.flowVars;
  if (!flowVars) return false;

  // ARA modification phases
  const araRaw = flowVars["__araState__"];
  if (araRaw) {
    try {
      const araState = JSON.parse(araRaw) as { phase?: string };
      if (araState.phase && ARA_ZERO_EXEMPT_PHASES.has(araState.phase)) return true;
    } catch { /* corrupted state — fall through */ }
  }

  // Any question node waiting for a numeric answer
  if (data.flow?.waitingFor === "answer" && flowVars["__questionType__"] === "number") return true;

  return false;
}
