-- AlterTable
ALTER TABLE "Guest" ADD COLUMN     "lastHandledByStaff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "handledAt" TIMESTAMP(3);
