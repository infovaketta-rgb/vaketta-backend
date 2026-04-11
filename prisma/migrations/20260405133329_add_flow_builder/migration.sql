-- AlterTable
ALTER TABLE "HotelMenuItem" ADD COLUMN     "flowId" TEXT;

-- CreateTable
CREATE TABLE "FlowDefinition" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "edges" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowDefinition_hotelId_idx" ON "FlowDefinition"("hotelId");

-- CreateIndex
CREATE INDEX "FlowDefinition_isTemplate_idx" ON "FlowDefinition"("isTemplate");

-- AddForeignKey
ALTER TABLE "HotelMenuItem" ADD CONSTRAINT "HotelMenuItem_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FlowDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowDefinition" ADD CONSTRAINT "FlowDefinition_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
