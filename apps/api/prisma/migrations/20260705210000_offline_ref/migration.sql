-- AlterTable: provisional device reference for offline orders (distinct from the
-- authoritative GST bill/invoice number, which the server assigns at sync time).
ALTER TABLE "orders" ADD COLUMN "offlineRef" TEXT;
