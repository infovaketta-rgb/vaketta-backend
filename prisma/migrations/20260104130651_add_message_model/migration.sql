-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "body" TEXT,
    "messageType" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_fromPhone_idx" ON "Message"("fromPhone");

-- CreateIndex
CREATE INDEX "Message_toPhone_idx" ON "Message"("toPhone");

-- CreateIndex
CREATE INDEX "Message_hotelId_idx" ON "Message"("hotelId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
