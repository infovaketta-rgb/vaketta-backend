-- ── Template Variable Mapping + Booking.flowVars ────────────────────────────────
-- The database is hosted on Supabase. `prisma migrate dev` can't reach the pooled
-- connection, so run this SQL by hand in the Supabase SQL editor, then locally run:
--   npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--       --to-schema-datamodel prisma/schema.prisma  (should report no drift)
--   npx prisma migrate resolve --applied 20260618000001_add_template_variable_mapping

-- AlterTable: snapshot of watched flow-builder vars captured at create_booking time.
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "flowVars" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TemplateVariableMapping" (
  "id"           TEXT NOT NULL,
  "hotelId"      TEXT NOT NULL,
  "templateId"   TEXT NOT NULL,
  "variableName" TEXT NOT NULL,
  "sourceType"   TEXT NOT NULL,
  "sourceKey"    TEXT NOT NULL,

  CONSTRAINT "TemplateVariableMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one mapping per (template, variable).
CREATE UNIQUE INDEX IF NOT EXISTS "TemplateVariableMapping_templateId_variableName_key"
  ON "TemplateVariableMapping" ("templateId", "variableName");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TemplateVariableMapping_hotelId_templateId_idx"
  ON "TemplateVariableMapping" ("hotelId", "templateId");

-- AddForeignKey
ALTER TABLE "TemplateVariableMapping"
  ADD CONSTRAINT "TemplateVariableMapping_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
