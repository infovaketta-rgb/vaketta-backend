/**
 * flowRuntime.ts
 *
 * Executes one step of a visual flow for a given guest session.
 * Called when session.state starts with "FLOW:{flowId}:{nodeId}".
 *
 * Node types handled:
 *   start, message, question, branch, action, end,
 *   check_availability, show_rooms
 *
 * Question types:
 *   text, room_selection (legacy), date, number, yes_no, rating
 *
 * Action types:
 *   create_booking, update_booking_status, start_booking_flow (legacy),
 *   handoff_to_staff, notify_staff, reset_to_menu, set_variable, send_review_request
 */
import { SessionData } from "../services/session.service";
export declare function executeFlowStep(hotelId: string, guestId: string, state: string, // "FLOW:{flowId}:{nodeId}"
sessionData: SessionData, input: string): Promise<string | null>;
//# sourceMappingURL=flowRuntime.d.ts.map