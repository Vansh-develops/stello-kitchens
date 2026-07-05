-- AlterTable: combo linkage on order lines
ALTER TABLE "order_items" ADD COLUMN "comboId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "comboGroupId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "isComboComponent" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "combos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "hsnCode" TEXT DEFAULT '996331',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_slots" (
    "id" TEXT NOT NULL,
    "comboId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "combo_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_slot_options" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "priceDelta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "combo_slot_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "combos_tenantId_outletId_idx" ON "combos"("tenantId", "outletId");

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "combo_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
