-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "checkInTime" TEXT NOT NULL DEFAULT '14:00',
ADD COLUMN     "checkOutTime" TEXT NOT NULL DEFAULT '11:00',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "website" TEXT;
