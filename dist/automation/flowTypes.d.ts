export type NodeType = "start" | "message" | "question" | "branch" | "action" | "end" | "check_availability" | "show_rooms";
export interface StartNodeData {
    label?: string;
}
/** Text in message nodes can reference collected variables with {{varName}} */
export interface MessageNodeData {
    text: string;
}
export type ValidationRule = "none" | "date" | "number" | "email";
/**
 * questionType determines how the bot sends the question and validates the answer:
 *   "text"           — free-text answer
 *   "room_selection" — legacy; use the show_rooms node instead for new flows
 *   "date"           — validates DD/MM/YYYY or YYYY-MM-DD; supports min/max constraints
 *   "number"         — validates numeric input; supports min/max range
 *   "yes_no"         — guest replies 1/yes or 2/no; customisable labels
 *   "rating"         — 1–N star rating; can auto-show a review link above threshold
 */
export type QuestionType = "text" | "room_selection" | "date" | "number" | "yes_no" | "rating";
export interface QuestionNodeData {
    text: string;
    questionType: QuestionType;
    variableName: string;
    validation: ValidationRule;
    validationError: string;
    dateMin?: "today" | "none";
    dateMaxDays?: number;
    numberMin?: number;
    numberMax?: number;
    yesLabel?: string;
    noLabel?: string;
    ratingMax?: number;
    ratingPositiveThreshold?: number;
    reviewUrl?: string;
}
export interface BranchCondition {
    id: string;
    variable: string;
    operator: "equals" | "not_equals" | "contains" | "starts_with" | "gt" | "lt";
    compareValue: string;
    label: string;
}
export interface BranchNodeData {
    conditions: BranchCondition[];
    defaultHandleId: string;
}
/**
 * check_availability node
 * Reads three flowVars → calls availability service → routes to "available" or "unavailable" handle.
 */
export interface CheckAvailabilityNodeData {
    roomTypeIdVar: string;
    checkInVar: string;
    checkOutVar: string;
    unavailableMessage?: string;
}
/**
 * show_rooms node
 * Fetches the hotel's room types (optionally filtered to available-only for given dates),
 * presents a numbered list, and stores the guest's selection under variableName.
 *
 * Stores: {variableName}TypeId, {variableName}TypeName, {variableName}Price
 * Also sets canonical aliases: bookingRoomTypeId, bookingRoomTypeName, bookingPricePerNight
 */
export interface ShowRoomsNodeData {
    text: string;
    filter: "all" | "available_only";
    checkInVar?: string;
    checkOutVar?: string;
    minCapacity?: number;
    minAdults?: number;
    minChildren?: number;
    variableName: string;
    validationError?: string;
}
/**
 * ActionType catalogue — every action the flow engine can perform
 */
export type ActionType = "create_booking" | "update_booking_status" | "start_booking_flow" | "handoff_to_staff" | "notify_staff" | "reset_to_menu" | "set_variable" | "send_review_request";
export interface ActionNodeData {
    actionType: ActionType;
    message?: string;
    guestNameVar?: string;
    roomTypeIdVar?: string;
    checkInVar?: string;
    checkOutVar?: string;
    advancePaidVar?: string;
    prefillFromVars?: boolean;
    bookingRefVar?: string;
    newStatus?: "CONFIRMED" | "CANCELLED" | "HOLD";
    variableToSet?: string;
    valueToSet?: string;
    reviewUrl?: string;
    reviewMessage?: string;
}
export interface EndNodeData {
    farewellText?: string;
}
export type FlowNodeData = StartNodeData | MessageNodeData | QuestionNodeData | BranchNodeData | CheckAvailabilityNodeData | ShowRoomsNodeData | ActionNodeData | EndNodeData;
export interface SerializedFlowNode {
    id: string;
    type: NodeType;
    position: {
        x: number;
        y: number;
    };
    data: FlowNodeData;
}
export interface SerializedFlowEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
}
//# sourceMappingURL=flowTypes.d.ts.map