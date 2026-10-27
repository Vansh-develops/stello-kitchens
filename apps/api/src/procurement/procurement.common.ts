import { ForbiddenException } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { Prisma } from "@prisma/client";

export const D = (n: Prisma.Decimal | number | null | undefined) =>
  n === null || n === undefined ? 0 : typeof n === "number" ? n : Number(n);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function assertOutlet(user: AuthUser, outletId: string) {
  if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
}

/** Server-local calendar day, matching how the reports module buckets sales. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDay(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

/** Consecutive local days from `start` (inclusive), `count` long. */
export function dayRange(start: Date, count: number): string[] {
  const out: string[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < count; i++) {
    out.push(localDay(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Next sequential document number for an outlet (PO-00001, GRN-00001, …).
 * A transaction-scoped advisory lock serialises numbering per outlet + kind
 * without touching the outlet row that billing locks.
 */
export async function nextDocNumber(
  tx: Prisma.TransactionClient,
  outletId: string,
  kind: "PO" | "GRN" | "SC",
  count: () => Promise<number>,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${kind}:${outletId}`}))`;
  const n = (await count()) + 1;
  return `${kind}-${String(n).padStart(5, "0")}`;
}
