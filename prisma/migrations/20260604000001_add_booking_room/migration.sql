-- CreateTable: per-room detail rows for multi-room group bookings.
-- bookingId  → Booking (cascade delete)
-- roomTypeId → RoomType (restrict, rooms don't disappear)
CREATE TABLE IF NOT EXISTS "BookingRoom" (
  "id"           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "bookingId"    TEXT        NOT NULL,
  "roomTypeId"   TEXT        NOT NULL,
  "adults"       INTEGER     NOT NULL DEFAULT 0,
  "children"     INTEGER     NOT NULL DEFAULT 0,
  "extraBed"     BOOLEAN     NOT NULL DEFAULT false,
  "pricePerNight" DOUBLE PRECISION NOT NULL,
  "totalPrice"    DOUBLE PRECISION NOT NULL,

  CONSTRAINT "BookingRoom_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingRoom_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE,
  CONSTRAINT "BookingRoom_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id")
);

CREATE INDEX IF NOT EXISTS "BookingRoom_bookingId_idx" ON "BookingRoom" ("bookingId");
