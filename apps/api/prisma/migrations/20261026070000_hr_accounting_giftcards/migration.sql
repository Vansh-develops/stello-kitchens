-- CreateTable
CREATE TABLE "staff_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "userId" TEXT,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "designation" TEXT,
    "joiningDate" DATE NOT NULL,
    "exitDate" DATE,
    "pinHash" TEXT,
    "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMP(3),
    "payType" TEXT NOT NULL DEFAULT 'MONTHLY',
    "payRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "allowances" JSONB,
    "deductions" JSONB,
    "pfApplicable" BOOLEAN NOT NULL DEFAULT false,
    "esiApplicable" BOOLEAN NOT NULL DEFAULT false,
    "ptApplicable" BOOLEAN NOT NULL DEFAULT false,
    "overtimeEligible" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakStartedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'PIN',
    "correctionReason" TEXT,
    "correctedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 30,
    "graceMinutes" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_shifts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "templateId" TEXT,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 30,
    "graceMinutes" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "roster_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_swap_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "fromShiftId" TEXT NOT NULL,
    "toStaffId" TEXT NOT NULL,
    "toShiftId" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "allotted" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "used" DECIMAL(5,1) NOT NULL DEFAULT 0,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "config" JSONB NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "monthlyRecovery" DECIMAL(12,2) NOT NULL,
    "recovered" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "givenOn" DATE NOT NULL,
    "paidFrom" TEXT NOT NULL DEFAULT 'BANK',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "finalisedById" TEXT,
    "finalisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "designation" TEXT,
    "payType" TEXT NOT NULL,
    "payRate" DECIMAL(12,2) NOT NULL,
    "inputs" JSONB NOT NULL,
    "lopDays" DECIMAL(5,1) NOT NULL,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "adjustments" JSONB,
    "calc" JSONB NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "employerCost" DECIMAL(12,2) NOT NULL,
    "advanceRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ledgerName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "itcEligible" BOOLEAN NOT NULL DEFAULT true,
    "vendorName" TEXT,
    "vendorGstin" TEXT,
    "invoiceNumber" TEXT,
    "paidFrom" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "attachmentUrl" TEXT,
    "cashMovementId" TEXT,
    "createdById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "issuedOutletId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GIFT_CARD',
    "initialValue" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "expiresOn" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "note" TEXT,
    "issuedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_txns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "orderId" TEXT,
    "paymentMode" TEXT,
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_card_txns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_members_tenantId_outletId_idx" ON "staff_members"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_tenantId_employeeCode_key" ON "staff_members"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_tenantId_userId_key" ON "staff_members"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "attendance_records_tenantId_outletId_date_idx" ON "attendance_records"("tenantId", "outletId", "date");

-- CreateIndex
CREATE INDEX "attendance_records_staffId_date_idx" ON "attendance_records"("staffId", "date");

-- CreateIndex
CREATE INDEX "shift_templates_tenantId_outletId_idx" ON "shift_templates"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "roster_shifts_tenantId_outletId_date_idx" ON "roster_shifts"("tenantId", "outletId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "roster_shifts_staffId_date_key" ON "roster_shifts"("staffId", "date");

-- CreateIndex
CREATE INDEX "shift_swap_requests_tenantId_outletId_status_idx" ON "shift_swap_requests"("tenantId", "outletId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_tenantId_outletId_status_idx" ON "leave_requests"("tenantId", "outletId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_staffId_fromDate_idx" ON "leave_requests"("staffId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_balances_tenantId_idx" ON "leave_balances"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_staffId_year_type_key" ON "leave_balances"("staffId", "year", "type");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_settings_tenantId_key" ON "payroll_settings"("tenantId");

-- CreateIndex
CREATE INDEX "salary_advances_tenantId_outletId_idx" ON "salary_advances"("tenantId", "outletId");

-- CreateIndex
CREATE INDEX "salary_advances_staffId_status_idx" ON "salary_advances"("staffId", "status");

-- CreateIndex
CREATE INDEX "payroll_runs_tenantId_outletId_idx" ON "payroll_runs"("tenantId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_outletId_month_key" ON "payroll_runs"("outletId", "month");

-- CreateIndex
CREATE INDEX "payslips_tenantId_idx" ON "payslips"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_runId_staffId_key" ON "payslips"("runId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_tenantId_name_key" ON "expense_categories"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_cashMovementId_key" ON "expenses"("cashMovementId");

-- CreateIndex
CREATE INDEX "expenses_tenantId_outletId_date_idx" ON "expenses"("tenantId", "outletId", "date");

-- CreateIndex
CREATE INDEX "gift_cards_tenantId_createdAt_idx" ON "gift_cards"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gift_cards_tenantId_code_key" ON "gift_cards"("tenantId", "code");

-- CreateIndex
CREATE INDEX "gift_card_txns_giftCardId_createdAt_idx" ON "gift_card_txns"("giftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_card_txns_tenantId_outletId_createdAt_idx" ON "gift_card_txns"("tenantId", "outletId", "createdAt");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_txns" ADD CONSTRAINT "gift_card_txns_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "gift_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

