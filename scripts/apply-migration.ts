import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  // Statement 1 — create BookingRoom table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BookingRoom" (
      "id"            TEXT             NOT NULL DEFAULT gen_random_uuid()::text,
      "bookingId"     TEXT             NOT NULL,
      "roomTypeId"    TEXT             NOT NULL,
      "adults"        INTEGER          NOT NULL DEFAULT 0,
      "children"      INTEGER          NOT NULL DEFAULT 0,
      "extraBed"      BOOLEAN          NOT NULL DEFAULT false,
      "pricePerNight" DOUBLE PRECISION NOT NULL,
      "totalPrice"    DOUBLE PRECISION NOT NULL,
      CONSTRAINT "BookingRoom_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "BookingRoom_bookingId_fkey"
        FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE,
      CONSTRAINT "BookingRoom_roomTypeId_fkey"
        FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id")
    )
  `);
  console.log("Table created.");

  // Statement 2 — index on bookingId
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "BookingRoom_bookingId_idx" ON "BookingRoom" ("bookingId")
  `);
  console.log("Index created.");

  console.log("Migration applied successfully.");
  await prisma.$disconnect();
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
