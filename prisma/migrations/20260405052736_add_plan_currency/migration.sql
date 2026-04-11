-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';
