// ── Flow node / edge types shared by runtime and frontend ─────────────────────

export type NodeType =
  | "start"
  | "message"
  | "question"
  | "branch"
  | "action"
  | "end"
  | "check_availability"  // checks room availability; routes available / unavailable
  | "show_rooms"          // displays a room list (all or available-only) and collects selection
  | "time_condition"      // branches by time-of-day using the hotel's business hours config
  | "jump"                // jumps to another node in the same flow (enables loops / sub-menus)
  | "show_menu"           // emits the hotel's formatted WhatsApp menu text inline
  | "send_template"       // sends an approved WhatsApp template; routes success / failure
  | "send_saved_reply"    // sends an internal saved reply with {{var}} resolution
  | "delay";              // pauses the flow for a configurable duration then resumes

// ── Per-node data shapes ───────────────────────────────────────────────────────

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
export type QuestionType =
  | "text"
  | "room_selection"
  | "date"
  | "number"
  | "yes_no"
  | "rating";

export interface QuestionNodeData {
  text:            string;
  questionType:    QuestionType;
  variableName:    string;
  validation:      ValidationRule; // only used when questionType === "text"
  validationError: string;

  // ── date options ────────────────────────────────────────────────────────────
  dateMin?:     "today" | "none"; // if "today", reject past dates
  dateMaxDays?: number;           // reject dates more than N days from today

  // ── number options ──────────────────────────────────────────────────────────
  numberMin?: number;
  numberMax?: number;

  // ── yes_no options ──────────────────────────────────────────────────────────
  yesLabel?: string; // default "Yes"
  noLabel?:  string; // default "No"

  // ── rating options ──────────────────────────────────────────────────────────
  ratingMax?:                number; // default 5
  ratingPositiveThreshold?:  number; // if score >= this, treat as positive
  reviewUrl?:                string; // URL to include when positive rating received
}

export interface BranchCondition {
  id:           string;
  variable:     string;
  operator:     "equals" | "not_equals" | "contains" | "starts_with" | "gt" | "lt";
  compareValue: string;
  label:        string;
}

export interface BranchNodeData {
  conditions:      BranchCondition[];
  defaultHandleId: string;
}

/**
 * check_availability node
 * Reads three flowVars → calls availability service → routes to "available" or "unavailable" handle.
 */
export interface CheckAvailabilityNodeData {
  roomTypeIdVar:      string;  // flowVar name holding the room-type UUID
  checkInVar:         string;  // flowVar name holding the check-in date string
  checkOutVar:        string;  // flowVar name holding the check-out date string
  unavailableMessage?: string; // optional message sent when room is unavailable
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
  text:             string;                   // prompt shown above the list
  filter:           "all" | "available_only"; // which rooms to include
  checkInVar?:      string;                   // required when filter === "available_only"
  checkOutVar?:     string;
  minCapacity?:     number;                   // only show rooms with capacity >= this
  minAdults?:       number;                   // only show rooms with maxAdults >= this
  minChildren?:     number;                   // only show rooms with maxChildren >= this
  variableName:     string;                   // key prefix for stored variables
  validationError?: string;
}

/**
 * ActionType catalogue — every action the flow engine can perform
 */
export type ActionType =
  | "create_booking"          // creates a Booking record from flowVars
  | "update_booking_status"   // updates an existing booking's status
  | "start_booking_flow"      // legacy: hands off to hardcoded booking state machine
  | "handoff_to_staff"        // opens an ENQUIRY_OPEN session, disables bot
  | "notify_staff"            // flags guest as staff-handled without stopping the flow
  | "reset_to_menu"           // resets session and shows main menu
  | "set_variable"            // writes a computed/static value into flowVars
  | "send_review_request"     // sends a review-link message
  | "view_bookings";          // fetches and formats the guest's booking history

export interface ActionNodeData {
  actionType: ActionType;
  message?:   string; // optional text sent before the action executes

  // ── create_booking ──────────────────────────────────────────────────────────
  guestNameVar?:   string;
  roomTypeIdVar?:  string;
  checkInVar?:     string;
  checkOutVar?:    string;
  advancePaidVar?: string;

  // ── start_booking_flow (legacy) ─────────────────────────────────────────────
  prefillFromVars?: boolean;

  // ── update_booking_status ───────────────────────────────────────────────────
  bookingRefVar?: string;                         // var holding bookingRef (first 8 chars of UUID)
  newStatus?:     "CONFIRMED" | "CANCELLED" | "HOLD";

  // ── set_variable ────────────────────────────────────────────────────────────
  variableToSet?: string;  // the key to write into flowVars
  valueToSet?:    string;  // the value; supports {{interpolation}}

  // ── send_review_request ─────────────────────────────────────────────────────
  reviewUrl?:     string;  // static URL (leave blank to use hotel settings)
  reviewMessage?: string;  // custom text; supports {{interpolation}}

  // ── business hours gate (handoff_to_staff / notify_staff) ─────────────────
  businessHoursOnly?:    boolean; // if true, skip node outside business hours
  outsideHoursMessage?:  string;  // reply when blocked; falls back to default if blank
}

export interface EndNodeData {
  farewellText?: string;
}

/**
 * delay node
 * Pauses flow execution for a configurable duration, then resumes from the
 * next connected node via a BullMQ job on the 'flow-resume' queue.
 */
export interface DelayNodeData {
  duration:       number;                       // e.g. 24
  unit:           "minutes" | "hours" | "days";
  resumeMessage?: string;  // optional message sent to guest when the pause starts
}

/**
 * time_condition node
 * Reads the hotel's businessStartHour / businessEndHour from HotelConfig and the hotel timezone.
 * Routes to one of three handles: "business_hours" | "after_hours" | "weekend"
 * No configuration required — the node automatically reads the hotel's schedule.
 */
export interface TimeConditionNodeData {
  label?: string; // optional canvas label
}

/**
 * jump node
 * Teleports flow execution to a different node in the same flow.
 * Useful for: returning to a choice menu, retrying a step, creating loops.
 * The MAX_HOPS guard still applies — jumps count as hops.
 */
export interface JumpNodeData {
  targetNodeId: string;  // the node ID to jump to
  label?:       string;  // optional canvas label for readability
}

/**
 * show_menu node
 * Emits the hotel's formatted WhatsApp menu text (same output as buildMenuMessage).
 * Useful when a menu flow starts with a greeting/time check before showing the menu.
 * After emitting, flow continues to the next node (usually an end or question node).
 */
export interface ShowMenuNodeData {
  label?: string;  // optional canvas label
}

/**
 * send_template node
 * Sends an approved WhatsApp template message to the guest.
 * Each {{n}} variable is resolved from the current flow variables via variableMapping.
 * Routes to "success" handle on successful send, "failure" handle if sending fails.
 */
export interface SendTemplateNodeData {
  templateId:      string;                   // WhatsApp template ID (UUID)
  templateName?:   string;                   // display-only label (resolved at save time)
  variableMapping: Record<string, string>;   // {"1":"guestName","2":"bookingCheckIn"} — flow var names
  failureMessage?: string;                   // optional message sent (via plain text) on failure
}

export type FlowNodeData =
  | StartNodeData
  | MessageNodeData
  | QuestionNodeData
  | BranchNodeData
  | CheckAvailabilityNodeData
  | ShowRoomsNodeData
  | ActionNodeData
  | EndNodeData
  | TimeConditionNodeData
  | JumpNodeData
  | ShowMenuNodeData
  | SendTemplateNodeData
  | DelayNodeData;

// ── Serialised graph (stored as JSON in FlowDefinition.nodes / .edges) ─────────

export interface SerializedFlowNode {
  id:       string;
  type:     NodeType;
  position: { x: number; y: number };
  data:     FlowNodeData;
}

export interface SerializedFlowEdge {
  id:            string;
  source:        string;
  target:        string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
