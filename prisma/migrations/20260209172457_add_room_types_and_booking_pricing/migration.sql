/*
  Warnings:

  - Added the required column `pricePerNight` to the `Booking` table without a default value. This is not possible if the table is not empty.
  - Added the required column `roomTypeId` to the `Booking` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalPrice` to the `Booking` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "pricePerNight" INTEGER NOT NULL,
ADD COLUMN     "roomTypeId" TEXT NOT NULL,
ADD COLUMN     "totalPrice" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "RoomType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basePrice" INTEGER NOT NULL,
    "capacity" INTEGER,
    "hotelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomType_hotelId_idx" ON "RoomType"("hotelId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
