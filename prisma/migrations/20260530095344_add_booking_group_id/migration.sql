-- AlterTable
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "bookingGroupId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Booking_bookingGroupId_idx"
  ON "Booking" ("bookingGroupId");
