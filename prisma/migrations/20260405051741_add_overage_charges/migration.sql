-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "extraAiReplyCharge" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraConversationCharge" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "extraAiReplyCharge" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraConversationCharge" INTEGER NOT NULL DEFAULT 0;
