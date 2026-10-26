import { describe, expect, it } from "vitest";
import {
  ApiKeyCreateSchema,
  PERMISSIONS,
  PERMISSION_KEYS,
  PermissionKeySchema,
  ReportScheduleSchema,
  groupPermissions,
  hasPermission,
  isOwnerLevel,
  missingPermissions,
} from "./platform";

describe("permission catalogue", () => {
  it("has unique, well-formed keys with descriptions", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const p of PERMISSIONS) {
      expect(PermissionKeySchema.safeParse(p.key).success).toBe(true);
      expect(p.description.length).toBeGreaterThan(5);
    }
  });

  it("covers every key the API already gates on", () => {
    for (const k of [
      "orders.create", "orders.settle", "orders.cancel", "kds.operate", "menu.stock", "menu.manage",
      "inventory.manage", "crm.manage", "reports.view", "finance.manage", "devices.manage", "settings.manage",
    ]) expect(PERMISSION_KEYS).toContain(k);
  });

  it("hasPermission honours the wildcard", () => {
    expect(hasPermission(["*"], "anything.here")).toBe(true);
    expect(hasPermission(["menu.stock"], "menu.stock")).toBe(true);
    expect(hasPermission(["menu.stock"], "menu.manage")).toBe(false);
  });

  it("missingPermissions blocks escalation", () => {
    expect(missingPermissions(["*"], ["*", "roles.manage"])).toEqual([]);
    expect(missingPermissions(["roles.manage", "menu.stock"], ["menu.stock"])).toEqual([]);
    expect(missingPermissions(["roles.manage"], ["menu.manage", "roles.manage", "menu.manage"])).toEqual(["menu.manage"]);
    expect(missingPermissions(["roles.manage"], ["*"])).toEqual(["*"]);
    expect(isOwnerLevel(["*"])).toBe(true);
    expect(isOwnerLevel(["roles.manage"])).toBe(false);
  });

  it("groups keys, putting uncatalogued keys under Other", () => {
    const groups = groupPermissions(["menu.stock", "reports.view", "loyalty.tiers"]);
    expect(groups.map((g) => g.group)).toEqual(["Menu", "Reports", "Other"]);
  });

  it("rejects malformed keys", () => {
    expect(PermissionKeySchema.safeParse("DROP TABLE").success).toBe(false);
    expect(PermissionKeySchema.safeParse("menu").success).toBe(false);
    expect(PermissionKeySchema.safeParse("*").success).toBe(true);
  });
});

describe("platform schemas", () => {
  it("API keys cannot hold the wildcard", () => {
    expect(ApiKeyCreateSchema.safeParse({ name: "k", permissions: ["*"] }).success).toBe(false);
    expect(ApiKeyCreateSchema.safeParse({ name: "k", permissions: ["orders.view"] }).success).toBe(true);
  });

  it("weekly schedules need a weekday", () => {
    const base = { name: "Daily", hour: 8, recipients: ["a@b.co"], reports: ["overview"] };
    expect(ReportScheduleSchema.safeParse({ ...base, frequency: "DAILY" }).success).toBe(true);
    expect(ReportScheduleSchema.safeParse({ ...base, frequency: "WEEKLY" }).success).toBe(false);
    expect(ReportScheduleSchema.safeParse({ ...base, frequency: "WEEKLY", weekday: 1 }).success).toBe(true);
    expect(ReportScheduleSchema.safeParse({ ...base, frequency: "DAILY", reports: ["nope"] }).success).toBe(false);
  });
});
