-- CreateTable
CREATE TABLE "HotelMenu" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'How can we help you?',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelMenuItem" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HotelMenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelMenu_hotelId_key" ON "HotelMenu"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "HotelMenuItem_menuId_key" ON "HotelMenuItem"("menuId");

-- CreateIndex
CREATE INDEX "HotelMenuItem_key_idx" ON "HotelMenuItem"("key");

-- AddForeignKey
ALTER TABLE "HotelMenu" ADD CONSTRAINT "HotelMenu_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelMenuItem" ADD CONSTRAINT "HotelMenuItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "HotelMenu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
