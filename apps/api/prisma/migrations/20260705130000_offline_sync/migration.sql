-- AlterTable: edge-device provenance for offline sync
ALTER TABLE "orders" ADD COLUMN "clientId" TEXT,
ADD COLUMN "deviceId" TEXT;

-- CreateIndex: idempotency for synced orders (NULLs are distinct, so cloud orders are unaffected)
CREATE UNIQUE INDEX "orders_deviceId_clientId_key" ON "orders"("deviceId", "clientId");

-- CreateIndex: delta pull by updated time
CREATE INDEX "orders_outletId_updatedAt_idx" ON "orders"("outletId", "updatedAt");
