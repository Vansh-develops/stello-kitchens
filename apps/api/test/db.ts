import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, beforeEach } from "vitest";
import { clearTenantContext } from "../src/common/tenant-context";

// A dedicated throwaway database on the dev Postgres (port 5455).
const TEST_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://stello:stello@localhost:5455/stello_test?schema=public";
process.env.DATABASE_URL = TEST_URL;

export const testPrisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

beforeAll(() => {
  // Create the DB if missing, then push the current schema to it.
  execSync(
    `docker exec stello-postgres psql -U stello -tc "SELECT 1 FROM pg_database WHERE datname='stello_test'" | grep -q 1 || docker exec stello-postgres createdb -U stello stello_test`,
    { stdio: "ignore", shell: "bash" },
  );
  execSync("pnpm --filter @stello/api exec prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
});

// Truncate every table between tests for isolation.
export async function resetDb(): Promise<void> {
  const rows = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  if (list) await testPrisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  clearTenantContext();
  await resetDb();
});
