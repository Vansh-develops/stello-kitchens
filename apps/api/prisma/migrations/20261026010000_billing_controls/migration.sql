-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "splitFromItemId" TEXT,
ADD COLUMN     "splitParts" INTEGER;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "allocatedDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "mergedIntoOrderId" TEXT,
ADD COLUMN     "parentOrderId" TEXT,
ADD COLUMN     "roundOff" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeTaxable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serviceChargeWaived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serviceChargeWaivedReason" TEXT,
ADD COLUMN     "splitCount" INTEGER,
ADD COLUMN     "splitIndex" INTEGER;

-- CreateTable
CREATE TABLE "outlet_billing_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "serviceChargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serviceChargePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "serviceChargeTaxable" BOOLEAN NOT NULL DEFAULT true,
    "serviceChargeOrderTypes" TEXT[] DEFAULT ARRAY['DINE_IN']::TEXT[],
    "roundOffEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parked_carts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "tableId" TEXT,
    "orderId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "lines" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "parkedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parked_carts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outlet_billing_settings_outletId_key" ON "outlet_billing_settings"("outletId");

-- CreateIndex
CREATE INDEX "outlet_billing_settings_tenantId_idx" ON "outlet_billing_settings"("tenantId");

-- CreateIndex
CREATE INDEX "parked_carts_tenantId_outletId_idx" ON "parked_carts"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "orders_parentOrderId_idx" ON "orders"("parentOrderId");

