import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const TEST_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://stello:stello@localhost:5455/stello_test?schema=public";

export default async function setup() {
  const adminUrl = TEST_URL.replace(/\/stello_test(\?|$)/, "/stello$1");
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const rows = await admin.$queryRawUnsafe<{ exists: boolean }[]>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'stello_test') AS exists",
    );
    if (!rows[0]?.exists) await admin.$executeRawUnsafe('CREATE DATABASE "stello_test"');
  } finally {
    await admin.$disconnect();
  }

  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
}
