import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped tenant context. The JWT guard establishes the current tenant
 * for the life of the request; PrismaService's query extension reads it to
 * structurally scope every tenant-owned query — a second line of defence so a
 * single forgotten `where: { tenantId }` can never leak across tenants.
 */
type TenantStore = { tenantId: string | null; unscoped: boolean };

const als = new AsyncLocalStorage<TenantStore>();

/** Bind the current async execution (this HTTP request) to a tenant. */
export function enterTenant(tenantId: string): void {
  als.enterWith({ tenantId, unscoped: false });
}

/**
 * Run `fn` with tenant scoping switched off — for audited cross-tenant/system
 * paths only.
 *
 * `fn`'s result is awaited *inside* the ALS scope (not just returned). A lazy
 * Prisma query (e.g. `prisma.role.findFirst(...)`) doesn't execute until
 * awaited, and PrismaService's tenant-scope extension reads `isUnscoped()` at
 * execution time — so if the caller awaited the returned promise outside this
 * function, the query would run under whatever ambient tenant context the
 * caller happens to be in, not this unscoped one. Awaiting here keeps the
 * unscoped context current for the entire lifetime of `fn()`, including
 * standalone (non-transaction) reads.
 */
export function runUnscoped<T>(fn: () => Promise<T> | T): Promise<T> {
  const cur = als.getStore();
  return als.run({ tenantId: cur?.tenantId ?? null, unscoped: true }, async () => await fn());
}

export function getTenantId(): string | null {
  return als.getStore()?.tenantId ?? null;
}

export function isUnscoped(): boolean {
  return als.getStore()?.unscoped ?? false;
}
