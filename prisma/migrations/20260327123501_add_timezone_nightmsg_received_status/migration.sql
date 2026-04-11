-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'RECEIVED';

-- AlterTable
ALTER TABLE "HotelConfig" ADD COLUMN     "nightMessage" TEXT NOT NULL DEFAULT '🌙 We''re currently outside business hours. We''ll get back to you when we open!',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';
