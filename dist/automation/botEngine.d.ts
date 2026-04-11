/**
 * botEngine.ts
 *
 * Per-hotel, per-guest conversation state machine.
 *
 * States
 * ──────
 * IDLE / AWAITING_SELECTION  — menu shown, waiting for guest to choose
 * BOOKING_NAME               — collecting guest full name
 * BOOKING_ROOM               — collecting room type selection
 * BOOKING_CHECKIN            — collecting check-in date
 * BOOKING_CHECKOUT           — collecting check-out date
 * BOOKING_CONFIRM            — showing summary, awaiting YES / NO
 * ENQUIRY_OPEN               — guest opened an enquiry; bot stays silent, staff takes over
 */
export type BotMessages = {
    menuGreeting?: string;
    menuFooter?: string;
    bookingStart?: string;
    bookingNoRooms?: string;
    bookingUnavailable?: string;
    bookingRoomNote?: string;
    bookingCheckInText?: string;
    bookingCheckOutText?: string;
    bookingSummaryNote?: string;
    bookingSuccess?: string;
    bookingCancel?: string;
    enquiryDefault?: string;
    menuFallback?: string;
};
export declare function processMessage(hotelId: string, guestId: string, body: string | null): Promise<string | null>;
//# sourceMappingURL=botEngine.d.ts.map