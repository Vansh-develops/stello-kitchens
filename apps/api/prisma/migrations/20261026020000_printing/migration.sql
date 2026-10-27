-- CreateTable
CREATE TABLE "printers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connection" TEXT NOT NULL DEFAULT 'BROWSER',
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "usbPath" TEXT,
    "paperWidth" INTEGER NOT NULL DEFAULT 80,
    "codepage" TEXT NOT NULL DEFAULT 'CP437',
    "printKots" BOOLEAN NOT NULL DEFAULT false,
    "printBills" BOOLEAN NOT NULL DEFAULT false,
    "stationIds" JSONB,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "autoPrintKot" BOOLEAN NOT NULL DEFAULT true,
    "autoPrintBill" BOOLEAN NOT NULL DEFAULT true,
    "drawerKick" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_print_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "fssaiNumber" TEXT,
    "headerLines" JSONB,
    "footerLines" JSONB,
    "upiQrOnBill" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_print_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "printerId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "reprint" BOOLEAN NOT NULL DEFAULT false,
    "openDrawer" BOOLEAN NOT NULL DEFAULT false,
    "orderId" TEXT,
    "kotId" TEXT,
    "sourceKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "printers_tenantId_outletId_idx" ON "printers"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_print_settings_outletId_key" ON "outlet_print_settings"("outletId");

-- CreateIndex
CREATE INDEX "outlet_print_settings_tenantId_idx" ON "outlet_print_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "print_jobs_sourceKey_key" ON "print_jobs"("sourceKey");

-- CreateIndex
CREATE INDEX "print_jobs_tenantId_outletId_status_createdAt_idx" ON "print_jobs"("tenantId", "outletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "print_jobs_orderId_idx" ON "print_jobs"("orderId");

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data: the fleet's PRINTER terminals only ever stored unused settings in
-- terminals.config (paperWidth/autoPrintKot/autoPrintBill/copies). Carry that
-- meaning into real printer rows (browser-printed until the outlet sets an
-- address), then retire the PRINTER terminals.
INSERT INTO "printers" ("id", "tenantId", "outletId", "name", "connection", "paperWidth", "printKots", "printBills",
  "copies", "autoPrintKot", "autoPrintBill", "isActive", "updatedAt")
SELECT
  'prn_' || t."id",
  t."tenantId",
  t."outletId",
  t."name",
  'BROWSER',
  CASE WHEN t."config"->>'paperWidth' = '58mm' THEN 58 ELSE 80 END,
  true,
  true,
  LEAST(GREATEST(COALESCE((t."config"->>'copies')::int, 1), 1), 5),
  COALESCE((t."config"->>'autoPrintKot')::boolean, true),
  COALESCE((t."config"->>'autoPrintBill')::boolean, true),
  t."isActive",
  CURRENT_TIMESTAMP
FROM "terminals" t
WHERE t."type" = 'PRINTER';

DELETE FROM "terminals" WHERE "type" = 'PRINTER';

-- Permissions: counter and kitchen staff print/reprint; configuring printers
-- (printers.manage) stays with owners ("*") and custom manager roles.
UPDATE "roles" SET "permissions" = "permissions" || '["printing.print"]'::jsonb
WHERE "name" IN ('Cashier', 'Kitchen')
  AND jsonb_typeof("permissions") = 'array'
  AND NOT ("permissions" ? 'printing.print');
