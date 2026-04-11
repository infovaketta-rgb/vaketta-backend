-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "amenities" TEXT[],
ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "RoomPhoto" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "roomTypeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomPhoto_roomTypeId_idx" ON "RoomPhoto"("roomTypeId");

-- AddForeignKey
ALTER TABLE "RoomPhoto" ADD CONSTRAINT "RoomPhoto_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
