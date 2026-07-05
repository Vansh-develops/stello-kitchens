-- AlterTable
ALTER TABLE "items" ADD COLUMN     "hsnCode" TEXT DEFAULT '996331';

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "placeOfSupply" TEXT;

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sellerGstin" TEXT,
    "buyerGstin" TEXT,
    "placeOfSupply" TEXT,
    "taxableValue" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL,
    "sgst" DECIMAL(12,2) NOT NULL,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "hsnSummary" JSONB,
    "irn" TEXT,
    "signedQr" TEXT,
    "ackNo" TEXT,
    "ackDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_orderId_key" ON "invoices"("orderId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_outletId_idx" ON "invoices"("tenantId", "outletId");
