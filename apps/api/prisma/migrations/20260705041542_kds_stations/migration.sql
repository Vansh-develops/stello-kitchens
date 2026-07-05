-- AlterTable
ALTER TABLE "menu_categories" ADD COLUMN     "stationId" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "prepStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "preppedAt" TIMESTAMP(3),
ADD COLUMN     "stationId" TEXT;

-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "prepMinutes" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stations_tenantId_outletId_idx" ON "stations"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "order_items_stationId_prepStatus_idx" ON "order_items"("stationId", "prepStatus");

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
