-- AlterTable
ALTER TABLE "items" ADD COLUMN     "availableEnd" TEXT,
ADD COLUMN     "availableStart" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DIRECT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_channel_prices" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isListed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "item_channel_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregator_menu_maps" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,

    CONSTRAINT "aggregator_menu_maps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channels_tenantId_outletId_idx" ON "channels"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "item_channel_prices_itemId_channelId_key" ON "item_channel_prices"("itemId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "aggregator_menu_maps_itemId_channelId_key" ON "aggregator_menu_maps"("itemId", "channelId");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_channel_prices" ADD CONSTRAINT "item_channel_prices_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_channel_prices" ADD CONSTRAINT "item_channel_prices_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aggregator_menu_maps" ADD CONSTRAINT "aggregator_menu_maps_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aggregator_menu_maps" ADD CONSTRAINT "aggregator_menu_maps_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
