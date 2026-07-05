-- AlterTable: managed-device fields on terminals
ALTER TABLE "terminals" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'POS';
ALTER TABLE "terminals" ADD COLUMN "config" JSONB;
ALTER TABLE "terminals" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
