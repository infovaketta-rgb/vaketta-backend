/*
  Warnings:

  - You are about to drop the column `name` on the `Booking` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Booking" DROP COLUMN "name",
ADD COLUMN     "guestName" TEXT;
