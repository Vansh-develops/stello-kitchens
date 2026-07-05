-- AlterTable: public tokens for kiosk / token-display and per-table QR
ALTER TABLE "outlets" ADD COLUMN "publicToken" TEXT;
ALTER TABLE "dining_tables" ADD COLUMN "publicToken" TEXT;

-- CreateTable
CREATE TABLE "order_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "tableId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'DINE_IN',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "items" JSONB NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "token" TEXT NOT NULL,
    "orderId" TEXT,
    "tokenNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "order_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outlets_publicToken_key" ON "outlets"("publicToken");
CREATE UNIQUE INDEX "dining_tables_publicToken_key" ON "dining_tables"("publicToken");
CREATE UNIQUE INDEX "order_requests_token_key" ON "order_requests"("token");
CREATE INDEX "order_requests_tenantId_outletId_status_idx" ON "order_requests"("tenantId", "outletId", "status");

-- AddForeignKey
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
