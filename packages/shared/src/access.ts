export type Surface = "console" | "pos" | "kds";

/** A surface is allowed if the user holds ANY of its gate permissions ("*" = all). */
const SURFACE_GATES: Record<Surface, string[]> = {
  console: ["menu.manage", "reports.view", "inventory.manage", "crm.manage", "finance.manage", "devices.manage"],
  pos: ["orders.settle"],
  kds: ["kds.operate"],
};

/** When several surfaces are allowed, this order picks the landing surface. */
const PRIMARY_ORDER: Surface[] = ["console", "pos", "kds"];

export interface SurfaceAccess {
  allowed: Surface[];
  primary: Surface | null;
}

export function surfaceAccess(permissions: string[]): SurfaceAccess {
  const has = (perm: string) => permissions.includes("*") || permissions.includes(perm);
  const allowed = (Object.keys(SURFACE_GATES) as Surface[]).filter((s) => SURFACE_GATES[s].some(has));
  const primary = PRIMARY_ORDER.find((s) => allowed.includes(s)) ?? null;
  return { allowed, primary };
}
