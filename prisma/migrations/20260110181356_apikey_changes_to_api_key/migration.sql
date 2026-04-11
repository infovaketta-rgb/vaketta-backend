/*
  Warnings:

  - You are about to drop the column `apikey` on the `Hotel` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[apiKey]` on the table `Hotel` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Hotel_apikey_key";

-- AlterTable
ALTER TABLE "Hotel" DROP COLUMN "apikey",
ADD COLUMN     "apiKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Hotel_apiKey_key" ON "Hotel"("apiKey");
