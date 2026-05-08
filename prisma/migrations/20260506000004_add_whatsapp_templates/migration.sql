-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');
CREATE TYPE "TemplateStatus"   AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id"                  TEXT NOT NULL,
    "hotelId"             TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "language"            TEXT NOT NULL,
    "category"            "TemplateCategory" NOT NULL,
    "status"              "TemplateStatus"   NOT NULL DEFAULT 'PENDING',
    "qualityScore"        TEXT,
    "metaTemplateId"      TEXT,
    "rejectionReason"     TEXT,
    "components"          JSONB NOT NULL,
    "allowCategoryChange" BOOLEAN NOT NULL DEFAULT true,
    "ttlSeconds"          INTEGER,
    "editCount"           INTEGER NOT NULL DEFAULT 0,
    "lastEditedAt"        TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_hotelId_idx"
    ON "WhatsAppTemplate"("hotelId");

CREATE UNIQUE INDEX "WhatsAppTemplate_hotelId_name_language_key"
    ON "WhatsAppTemplate"("hotelId", "name", "language");

-- AddForeignKey
ALTER TABLE "WhatsAppTemplate"
    ADD CONSTRAINT "WhatsAppTemplate_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
