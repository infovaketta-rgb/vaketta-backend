-- CreateTable
CREATE TABLE "HotelConfig" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "bookingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "businessStartHour" INTEGER NOT NULL DEFAULT 9,
    "businessEndHour" INTEGER NOT NULL DEFAULT 21,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "welcomeMessage" TEXT NOT NULL DEFAULT '👋 Thanks for contacting us! Our team will assist you shortly.',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelConfig_hotelId_key" ON "HotelConfig"("hotelId");

-- AddForeignKey
ALTER TABLE "HotelConfig" ADD CONSTRAINT "HotelConfig_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
