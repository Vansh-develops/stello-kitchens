-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TenantOrigin" AS ENUM ('SEED', 'ADMIN', 'SIGNUP');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "createdVia" "TenantOrigin" NOT NULL DEFAULT 'SEED',
ADD COLUMN     "onboardedAt" TIMESTAMP(3),
ADD COLUMN     "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
