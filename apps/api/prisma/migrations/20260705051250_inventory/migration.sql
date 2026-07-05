-- CreateTable
CREATE TABLE "raw_materials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "stockQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reorderLevel" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "costPerUnit" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "raw_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,4),
    "reason" TEXT,
    "vendorId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "raw_materials_tenantId_outletId_idx" ON "raw_materials"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_ingredients_itemId_rawMaterialId_key" ON "recipe_ingredients"("itemId", "rawMaterialId");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_outletId_createdAt_idx" ON "stock_movements"("tenantId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_rawMaterialId_idx" ON "stock_movements"("rawMaterialId");

-- AddForeignKey
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "raw_materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "raw_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
