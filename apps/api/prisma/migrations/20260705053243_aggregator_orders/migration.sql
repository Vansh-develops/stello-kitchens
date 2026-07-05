-- CreateTable
CREATE TABLE "aggregator_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "customerName" TEXT,
    "customerPhoneMasked" TEXT,
    "orderValue" DECIMAL(10,2) NOT NULL,
    "unmatchedItems" JSONB,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aggregator_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aggregator_orders_tenantId_outletId_status_idx" ON "aggregator_orders"("tenantId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "aggregator_orders_platform_externalOrderId_key" ON "aggregator_orders"("platform", "externalOrderId");
