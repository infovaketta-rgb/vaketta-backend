-- CreateTable
CREATE TABLE "PausedFlow" (
    "id"        TEXT NOT NULL,
    "hotelId"   TEXT NOT NULL,
    "guestId"   TEXT NOT NULL,
    "flowId"    TEXT NOT NULL,
    "nodeId"    TEXT NOT NULL,
    "flowVars"  JSONB NOT NULL,
    "resumeAt"  TIMESTAMP(3) NOT NULL,
    "jobId"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PausedFlow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PausedFlow_guestId_hotelId_idx" ON "PausedFlow"("guestId", "hotelId");

-- CreateIndex
CREATE INDEX "PausedFlow_resumeAt_idx" ON "PausedFlow"("resumeAt");

-- AddForeignKey
ALTER TABLE "PausedFlow" ADD CONSTRAINT "PausedFlow_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PausedFlow" ADD CONSTRAINT "PausedFlow_guestId_fkey"
    FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
