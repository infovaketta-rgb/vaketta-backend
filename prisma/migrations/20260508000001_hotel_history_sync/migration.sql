-- Add WhatsApp Coexistence history sync state fields to Hotel
ALTER TABLE "Hotel" ADD COLUMN "historySyncStatus"    TEXT;
ALTER TABLE "Hotel" ADD COLUMN "historySyncProgress"  INTEGER;
ALTER TABLE "Hotel" ADD COLUMN "historySyncStarted"   TIMESTAMP(3);
ALTER TABLE "Hotel" ADD COLUMN "historySyncCompleted" TIMESTAMP(3);



























