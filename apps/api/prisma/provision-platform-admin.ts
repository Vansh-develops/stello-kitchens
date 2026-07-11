import { PrismaClient } from "@prisma/client";

export async function promotePlatformAdmin(prisma: PrismaClient, email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return false;
  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
  return true;
}

// CLI entry: `pnpm --filter @stello/api provision:platform-admin <email>`
// Falls back to PLATFORM_ADMIN_EMAIL.
async function main() {
  const email = process.argv[2] ?? process.env.PLATFORM_ADMIN_EMAIL;
  if (!email) {
    console.error("Usage: provision:platform-admin <email>  (or set PLATFORM_ADMIN_EMAIL)");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const ok = await promotePlatformAdmin(prisma, email);
  await prisma.$disconnect();
  console.log(ok ? `Promoted ${email} to platform admin.` : `No user found for ${email}.`);
  process.exit(ok ? 0 : 1);
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("provision-platform-admin.ts")) void main();
