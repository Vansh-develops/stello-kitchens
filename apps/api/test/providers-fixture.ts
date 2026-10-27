import { vi } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { AuthUser } from "@stello/shared";
import type { PrismaService } from "../src/prisma/prisma.service";

/** A tenant with one outlet, an owner, one ₹100 + 5% item. */
export async function providerFixture(prisma: PrismaService) {
  const tenant = await prisma.tenant.create({ data: { name: "Providers" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({
    data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "test-only" },
  });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({
    data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet", gstin: "29AABCU9603R1ZM", placeOfSupply: "29", upiVpa: "outlet@okhdfc" },
  });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
  const item = await prisma.item.create({
    data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Meal", price: 100, taxRate: 5 },
  });
  const user: AuthUser = {
    id: actor.id,
    tenantId: tenant.id,
    email: actor.email,
    name: "Owner",
    roleName: "Owner",
    permissions: ["*"],
    outletIds: [outlet.id],
    isPlatformAdmin: false,
  };
  return { tenant, outlet, item, user };
}

export const realtimeStub = () => {
  const emit = vi.fn();
  return { emit, gateway: { notifyOutlet: vi.fn(), server: { to: vi.fn(() => ({ emit })) } } };
};

/** Install an undici MockAgent as the global fetch dispatcher; returns a restore fn. */
export function mockHttp(): { agent: MockAgent; restore: () => void } {
  const previous: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return {
    agent,
    restore: () => {
      setGlobalDispatcher(previous);
      void agent.close();
    },
  };
}

export type Captured = { path: string; method: string; headers: Record<string, string>; body: unknown };

/** Normalise undici's intercept-callback headers (object or flat array) to a lower-case map. */
export function headerMap(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

export function capture(list: Captured[], reply: unknown, statusCode = 200) {
  return (opts: { path: string; method: string; headers?: unknown; body?: unknown }) => {
    const raw = typeof opts.body === "string" ? opts.body : opts.body ? Buffer.from(opts.body as Uint8Array).toString("utf8") : "";
    list.push({ path: opts.path, method: opts.method, headers: headerMap(opts.headers), body: raw ? JSON.parse(raw) : null });
    return { statusCode, data: JSON.stringify(reply), responseOptions: { headers: { "content-type": "application/json" } } };
  };
}
