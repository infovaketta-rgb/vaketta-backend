import type { MessageChannel } from "@prisma/client";

// Shared job-payload types for the confirmation-sequence queue. Kept separate from
// the worker module so the controller (enqueue side) imports these WITHOUT pulling
// in the worker's BullMQ side effects.

export interface ConfirmationStepJob {
  stepId:  string;
  refType: "TEMPLATE" | "SAVED_REPLY";
  refId:   string;
  skip:    boolean;
  // Staff-filled / auto-derived template variable values. Only meaningful for
  // TEMPLATE steps; merged over the booking-level vars at send time.
  variables?: Record<string, string>;
}

export interface ConfirmationSequenceJobData {
  hotelId:    string;
  bookingId:  string;
  guestId:    string;
  guestPhone: string;
  fromPhone:  string;
  channel:    MessageChannel;
  vars:       Record<string, string>;
  steps:      ConfirmationStepJob[];
}
