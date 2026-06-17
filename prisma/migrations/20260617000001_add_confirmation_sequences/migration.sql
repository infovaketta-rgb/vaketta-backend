-- ── Confirmation Sequences ──────────────────────────────────────────────────────
-- The database is hosted on Supabase. `prisma migrate dev` can't reach the pooled
-- connection, so run this SQL by hand in the Supabase SQL editor, then locally run:
--   npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--       --to-schema-datamodel prisma/schema.prisma  (should report no drift)
--   npx prisma migrate resolve --applied 20260617000001_add_confirmation_sequences

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConfirmationSequence" (
  "id"            TEXT NOT NULL,
  "hotelId"       TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "isDefault"     BOOLEAN NOT NULL DEFAULT false,
  "roomTypeScope" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConfirmationSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConfirmationSequenceStep" (
  "id"         TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "order"      INTEGER NOT NULL,
  "refType"    TEXT NOT NULL,
  "refId"      TEXT NOT NULL,

  CONSTRAINT "ConfirmationSequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConfirmationSequence_hotelId_channel_idx"
  ON "ConfirmationSequence" ("hotelId", "channel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConfirmationSequenceStep_sequenceId_order_idx"
  ON "ConfirmationSequenceStep" ("sequenceId", "order");

-- AddForeignKey
ALTER TABLE "ConfirmationSequence"
  ADD CONSTRAINT "ConfirmationSequence_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmationSequenceStep"
  ADD CONSTRAINT "ConfirmationSequenceStep_sequenceId_fkey"
  FOREIGN KEY ("sequenceId") REFERENCES "ConfirmationSequence" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
