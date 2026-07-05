-- CreateTable: one-time codes that gate points redemption at billing
CREATE TABLE "loyalty_otps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_otps_outletId_phone_idx" ON "loyalty_otps"("outletId", "phone");
