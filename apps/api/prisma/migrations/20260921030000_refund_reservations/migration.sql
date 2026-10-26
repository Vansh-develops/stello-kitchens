ALTER TABLE "refunds" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PROCESSED';
ALTER TABLE "refunds" ADD COLUMN "requestKey" TEXT;
CREATE UNIQUE INDEX "refunds_tenantId_outletId_orderId_requestKey_key"
  ON "refunds"("tenantId", "outletId", "orderId", "requestKey");
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");
