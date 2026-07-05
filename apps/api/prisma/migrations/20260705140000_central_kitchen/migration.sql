-- AlterTable: designate a commissary
ALTER TABLE "outlets" ADD COLUMN "isCentralKitchen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "indents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromOutletId" TEXT NOT NULL,
    "toOutletId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    CONSTRAINT "indents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indent_items" (
    "id" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "requestedQty" DECIMAL(12,3) NOT NULL,
    "dispatchedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    CONSTRAINT "indent_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eway_bills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "ewbNo" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "fromGstin" TEXT,
    "toGstin" TEXT,
    "distanceKm" INTEGER,
    "validUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "eway_bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indents_tenantId_fromOutletId_idx" ON "indents"("tenantId", "fromOutletId");
CREATE INDEX "indents_tenantId_toOutletId_idx" ON "indents"("tenantId", "toOutletId");
CREATE UNIQUE INDEX "eway_bills_indentId_key" ON "eway_bills"("indentId");

-- AddForeignKey
ALTER TABLE "indent_items" ADD CONSTRAINT "indent_items_indentId_fkey" FOREIGN KEY ("indentId") REFERENCES "indents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_indentId_fkey" FOREIGN KEY ("indentId") REFERENCES "indents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
