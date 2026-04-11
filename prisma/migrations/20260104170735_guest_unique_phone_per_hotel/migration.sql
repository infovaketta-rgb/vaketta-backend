/*
  Warnings:

  - A unique constraint covering the columns `[phone,hotelId]` on the table `Guest` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Guest_phone_hotelId_key" ON "Guest"("phone", "hotelId");
