-- CreateEnum
CREATE TYPE "FlowVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "FlowDefinition" ADD COLUMN "publishedVersionId" TEXT;
ALTER TABLE "FlowDefinition" ADD COLUMN "draftVersionId" TEXT;

-- CreateTable
CREATE TABLE "FlowVersion" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "status" "FlowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FlowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlowVersion_flowId_versionNumber_key" ON "FlowVersion"("flowId", "versionNumber");

-- CreateIndex
CREATE INDEX "FlowVersion_flowId_status_idx" ON "FlowVersion"("flowId", "status");

-- AddForeignKey
ALTER TABLE "FlowVersion" ADD CONSTRAINT "FlowVersion_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "FlowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: seed PUBLISHED v1 for all flows that already have nodes
INSERT INTO "FlowVersion" (id, "flowId", "versionNumber", nodes, edges, status, "publishedAt", "createdBy")
SELECT
    gen_random_uuid(),
    id,
    1,
    nodes,
    edges,
    'PUBLISHED',
    NOW(),
    'system'
FROM "FlowDefinition"
WHERE nodes IS NOT NULL AND nodes::text != '[]';

-- Point each flow's publishedVersionId at its newly seeded v1
UPDATE "FlowDefinition" fd
SET "publishedVersionId" = fv.id
FROM "FlowVersion" fv
WHERE fv."flowId" = fd.id AND fv."versionNumber" = 1;
