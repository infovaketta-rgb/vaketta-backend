-- CreateIndex
CREATE INDEX "Booking_hotelId_status_idx" ON "Booking"("hotelId", "status");

-- CreateIndex
CREATE INDEX "Booking_guestId_idx" ON "Booking"("guestId");

-- CreateIndex
CREATE INDEX "Booking_checkIn_checkOut_idx" ON "Booking"("checkIn", "checkOut");

-- CreateIndex
CREATE INDEX "ConversationSession_hotelId_state_idx" ON "ConversationSession"("hotelId", "state");

-- CreateIndex
CREATE INDEX "ConversationSession_updatedAt_idx" ON "ConversationSession"("updatedAt");

-- CreateIndex
CREATE INDEX "Message_wamid_idx" ON "Message"("wamid");

-- CreateIndex
CREATE INDEX "Message_guestId_timestamp_idx" ON "Message"("guestId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_hotelId_direction_idx" ON "Message"("hotelId", "direction");
