-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "wamid" TEXT;
