/*
  Warnings:

  - A unique constraint covering the columns `[apikey]` on the table `Hotel` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "apikey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Hotel_apikey_key" ON "Hotel"("apikey");
