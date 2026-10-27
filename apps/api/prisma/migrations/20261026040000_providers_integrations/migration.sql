-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "ewbNo" TEXT,
ADD COLUMN     "ewbValidTill" TIMESTAMP(3),
ADD COLUMN     "gspProvider" TEXT;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "gatewayPaymentId" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "gateway_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "providerRef" TEXT,
    "paymentId" TEXT,
    "imageUrl" TEXT,
    "shortUrl" TEXT,
    "upiString" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsSenderId" TEXT,
    "whatsappPhoneNumberId" TEXT,
    "otpChannel" TEXT NOT NULL DEFAULT 'SMS',
    "templates" JSONB,
    "ratePerMinute" INTEGER NOT NULL DEFAULT 60,
    "lowStockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lowStockRecipients" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messaging_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT,
    "campaignId" TEXT,
    "purpose" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "vars" JSONB,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_opt_outs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoice_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "location" TEXT NOT NULL,
    "pincode" INTEGER NOT NULL,
    "stateCode" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "low_stock_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "isLow" BOOLEAN NOT NULL DEFAULT false,
    "lastAlertAt" TIMESTAMP(3),

    CONSTRAINT "low_stock_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "low_stock_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "stockQty" DECIMAL(12,3) NOT NULL,
    "reorderLevel" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "low_stock_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregator_sync_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "referenceId" TEXT,
    "detail" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aggregator_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gateway_payments_tenantId_outletId_orderId_idx" ON "gateway_payments"("tenantId", "outletId", "orderId");

-- CreateIndex
CREATE INDEX "gateway_payments_status_expiresAt_idx" ON "gateway_payments"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_provider_providerRef_key" ON "gateway_payments"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_events_provider_eventId_key" ON "gateway_events"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_configs_tenantId_key" ON "messaging_configs"("tenantId");

-- CreateIndex
CREATE INDEX "message_outbox_status_nextAttemptAt_idx" ON "message_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "message_outbox_tenantId_campaignId_idx" ON "message_outbox"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "message_outbox_providerMessageId_idx" ON "message_outbox"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_opt_outs_tenantId_phone_channel_key" ON "messaging_opt_outs"("tenantId", "phone", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_profiles_outletId_key" ON "einvoice_profiles"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "low_stock_states_rawMaterialId_key" ON "low_stock_states"("rawMaterialId");

-- CreateIndex
CREATE INDEX "low_stock_states_tenantId_outletId_idx" ON "low_stock_states"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "low_stock_alerts_tenantId_outletId_createdAt_idx" ON "low_stock_alerts"("tenantId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "aggregator_sync_logs_tenantId_outletId_createdAt_idx" ON "aggregator_sync_logs"("tenantId", "outletId", "createdAt");

