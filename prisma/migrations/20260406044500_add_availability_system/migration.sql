-- AlterTable
ALTER TABLE "HotelConfig" ADD COLUMN     "availabilityEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "totalRooms" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RoomInventory" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "availableRooms" INTEGER NOT NULL,
    "price" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomInventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomInventory_hotelId_date_idx" ON "RoomInventory"("hotelId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RoomInventory_roomTypeId_date_key" ON "RoomInventory"("roomTypeId", "date");

-- AddForeignKey
ALTER TABLE "RoomInventory" ADD CONSTRAINT "RoomInventory_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInventory" ADD CONSTRAINT "RoomInventory_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
