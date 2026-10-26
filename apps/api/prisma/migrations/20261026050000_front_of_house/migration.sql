-- AlterTable
ALTER TABLE "items" ADD COLUMN     "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "floor_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1000,
    "height" INTEGER NOT NULL DEFAULT 700,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floor_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_placements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "shape" TEXT NOT NULL DEFAULT 'SQUARE',

    CONSTRAINT "table_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 90,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "source" TEXT NOT NULL DEFAULT 'PHONE',
    "notes" TEXT,
    "customerId" TEXT,
    "createdById" TEXT,
    "seatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_tables" (
    "reservationId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,

    CONSTRAINT "reservation_tables_pkey" PRIMARY KEY ("reservationId","tableId")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "phone" TEXT,
    "partySize" INTEGER NOT NULL,
    "quotedMinutes" INTEGER NOT NULL DEFAULT 15,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "notes" TEXT,
    "tableId" TEXT,
    "customerId" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "seatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_calls" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DINER',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waiter_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "areaId" TEXT,
    "tableId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waiter_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tableId" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cfd_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "outletId" TEXT,
    "token" TEXT NOT NULL,
    "pairingCode" TEXT NOT NULL,
    "pairedById" TEXT,
    "pairedAt" TIMESTAMP(3),
    "state" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cfd_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "floor_plans_areaId_key" ON "floor_plans"("areaId");

-- CreateIndex
CREATE INDEX "floor_plans_tenantId_outletId_idx" ON "floor_plans"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "table_placements_tableId_key" ON "table_placements"("tableId");

-- CreateIndex
CREATE INDEX "table_placements_tenantId_outletId_idx" ON "table_placements"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "reservations_tenantId_outletId_startAt_idx" ON "reservations"("tenantId", "outletId", "startAt");

-- CreateIndex
CREATE INDEX "reservation_tables_tableId_idx" ON "reservation_tables"("tableId");

-- CreateIndex
CREATE INDEX "waitlist_entries_tenantId_outletId_status_idx" ON "waitlist_entries"("tenantId", "outletId", "status");

-- CreateIndex
CREATE INDEX "server_calls_tenantId_outletId_status_idx" ON "server_calls"("tenantId", "outletId", "status");

-- CreateIndex
CREATE INDEX "server_calls_tableId_status_idx" ON "server_calls"("tableId", "status");

-- CreateIndex
CREATE INDEX "waiter_assignments_outletId_userId_idx" ON "waiter_assignments"("outletId", "userId");

-- CreateIndex
CREATE INDEX "waiter_assignments_tenantId_outletId_idx" ON "waiter_assignments"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "bill_requests_orderId_key" ON "bill_requests"("orderId");

-- CreateIndex
CREATE INDEX "bill_requests_tenantId_outletId_idx" ON "bill_requests"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "cfd_sessions_token_key" ON "cfd_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "cfd_sessions_pairingCode_key" ON "cfd_sessions"("pairingCode");

-- CreateIndex
CREATE INDEX "cfd_sessions_tenantId_outletId_idx" ON "cfd_sessions"("tenantId", "outletId");

-- AddForeignKey
ALTER TABLE "table_placements" ADD CONSTRAINT "table_placements_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "floor_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

