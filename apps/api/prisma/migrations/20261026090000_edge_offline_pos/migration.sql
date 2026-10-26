-- CreateTable
CREATE TABLE "edge_devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "seriesCode" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPushAt" TIMESTAMP(3),
    "lastPullAt" TIMESTAMP(3),
    "clockSkewMs" INTEGER,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "edge_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_feed_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_feed_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_feed_states" (
    "outletId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_feed_states_pkey" PRIMARY KEY ("outletId")
);

-- CreateTable
CREATE TABLE "edge_staff_pins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "setById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_staff_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_invoice_seqs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "edgeDeviceId" TEXT NOT NULL,
    "seriesCode" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "billNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_invoice_seqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_sync_conflicts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "edgeDeviceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "orderId" TEXT,
    "billNumber" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "edge_devices_tenantId_outletId_idx" ON "edge_devices"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "edge_devices_terminalId_idx" ON "edge_devices"("terminalId");

-- CreateIndex
CREATE UNIQUE INDEX "edge_devices_outletId_seriesCode_key" ON "edge_devices"("outletId", "seriesCode");

-- CreateIndex
CREATE INDEX "edge_feed_entries_outletId_seq_idx" ON "edge_feed_entries"("outletId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "edge_feed_entries_outletId_entity_entityId_key" ON "edge_feed_entries"("outletId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "edge_staff_pins_userId_key" ON "edge_staff_pins"("userId");

-- CreateIndex
CREATE INDEX "edge_staff_pins_tenantId_idx" ON "edge_staff_pins"("tenantId");

-- CreateIndex
CREATE INDEX "edge_invoice_seqs_tenantId_outletId_idx" ON "edge_invoice_seqs"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "edge_invoice_seqs_edgeDeviceId_fiscalYear_seq_key" ON "edge_invoice_seqs"("edgeDeviceId", "fiscalYear", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "edge_invoice_seqs_outletId_billNumber_key" ON "edge_invoice_seqs"("outletId", "billNumber");

-- CreateIndex
CREATE INDEX "edge_sync_conflicts_tenantId_outletId_status_idx" ON "edge_sync_conflicts"("tenantId", "outletId", "status");

