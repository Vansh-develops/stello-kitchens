-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- AlterTable
ALTER TABLE "addon_groups" ADD COLUMN     "masterAddonGroupId" TEXT;

-- AlterTable
ALTER TABLE "combos" ADD COLUMN     "masterComboId" TEXT;

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "masterItemId" TEXT,
ADD COLUMN     "masterVersion" INTEGER,
ADD COLUMN     "nameTranslations" JSONB;

-- AlterTable
ALTER TABLE "menu_categories" ADD COLUMN     "masterCategoryId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT;

-- CreateTable
CREATE TABLE "master_menus" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stationName" TEXT,
    "deletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortCode" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "hsnCode" TEXT DEFAULT '996331',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "availableStart" TEXT,
    "availableEnd" TEXT,
    "variations" JSONB,
    "addonGroupIds" JSONB,
    "nameTranslations" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_addon_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "addons" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_addon_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_combos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "hsnCode" TEXT DEFAULT '996331',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "slots" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_item_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "masterItemId" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "inStock" BOOLEAN,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_item_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_menu_syncs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'NEVER',
    "lastPublishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "outlet_menu_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_publications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedById" TEXT,
    "outletIds" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMonthly" INTEGER NOT NULL,
    "priceYearly" INTEGER NOT NULL,
    "limits" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "providerPlanId" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "providerSubscriptionId" TEXT,
    "checkoutUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "providerEventId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "billing_counters_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "master_menus_brandId_key" ON "master_menus"("brandId");

-- CreateIndex
CREATE INDEX "master_menus_tenantId_idx" ON "master_menus"("tenantId");

-- CreateIndex
CREATE INDEX "master_categories_tenantId_brandId_idx" ON "master_categories"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "master_items_tenantId_brandId_idx" ON "master_items"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "master_addon_groups_tenantId_brandId_idx" ON "master_addon_groups"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "master_combos_tenantId_brandId_idx" ON "master_combos"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "master_item_overrides_tenantId_outletId_idx" ON "master_item_overrides"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "master_item_overrides_outletId_masterItemId_key" ON "master_item_overrides"("outletId", "masterItemId");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_menu_syncs_outletId_key" ON "outlet_menu_syncs"("outletId");

-- CreateIndex
CREATE INDEX "outlet_menu_syncs_tenantId_brandId_idx" ON "outlet_menu_syncs"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "menu_publications_tenantId_brandId_createdAt_idx" ON "menu_publications"("tenantId", "brandId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_tenantId_key" ON "tenant_subscriptions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_providerSubscriptionId_key" ON "tenant_subscriptions"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_number_key" ON "subscription_invoices"("number");

-- CreateIndex
CREATE INDEX "subscription_invoices_tenantId_createdAt_idx" ON "subscription_invoices"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_events_providerEventId_key" ON "subscription_events"("providerEventId");

-- CreateIndex
CREATE INDEX "subscription_events_tenantId_createdAt_idx" ON "subscription_events"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "master_items" ADD CONSTRAINT "master_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "master_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_combos" ADD CONSTRAINT "master_combos_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "master_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_item_overrides" ADD CONSTRAINT "master_item_overrides_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "master_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "tenant_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

