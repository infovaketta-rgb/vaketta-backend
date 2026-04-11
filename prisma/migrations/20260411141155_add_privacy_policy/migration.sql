-- CreateTable
CREATE TABLE "PrivacyPolicy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "effectiveDate" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyPolicy_pkey" PRIMARY KEY ("id")
);
