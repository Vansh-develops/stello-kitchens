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

/** Run `fn` with tenant scoping switched off — for audited cross-tenant/system paths only. */
export function runUnscoped<T>(fn: () => T): T {
  const cur = als.getStore();
  return als.run({ tenantId: cur?.tenantId ?? null, unscoped: true }, fn);
}

export function getTenantId(): string | null {
  return als.getStore()?.tenantId ?? null;
}

export function isUnscoped(): boolean {
  return als.getStore()?.unscoped ?? false;
}
