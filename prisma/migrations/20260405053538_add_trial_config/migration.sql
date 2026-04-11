-- CreateTable
CREATE TABLE "TrialConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "durationDays" INTEGER NOT NULL DEFAULT 14,
    "conversationLimit" INTEGER NOT NULL DEFAULT 500,
    "aiReplyLimit" INTEGER NOT NULL DEFAULT 200,
    "autoStartOnCreate" BOOLEAN NOT NULL DEFAULT true,
    "trialMessage" TEXT NOT NULL DEFAULT 'You are on a free trial. Upgrade to a paid plan to continue after the trial ends.',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialConfig_pkey" PRIMARY KEY ("id")
);
