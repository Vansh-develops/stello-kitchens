import { describe, it, expect } from "vitest";
import { surfaceAccess } from "./access";

describe("surfaceAccess", () => {
  it("owner (*) gets every surface, primary console", () => {
    expect(surfaceAccess(["*"])).toEqual({ allowed: ["console", "pos", "kds", "captain"], primary: "console" });
  });
  it("waiter (captain.operate) → captain only", () => {
    expect(surfaceAccess(["orders.create", "captain.operate"])).toEqual({ allowed: ["captain"], primary: "captain" });
  });
  it("cashier (orders.settle) → POS only", () => {
    expect(surfaceAccess(["orders.settle"])).toEqual({ allowed: ["pos"], primary: "pos" });
  });
  it("kitchen (kds.operate + menu.stock) → KDS only", () => {
    expect(surfaceAccess(["kds.operate", "menu.stock"])).toEqual({ allowed: ["kds"], primary: "kds" });
  });
  it("manager (reports.view) → Console only", () => {
    expect(surfaceAccess(["reports.view"])).toEqual({ allowed: ["console"], primary: "console" });
  });
  it("cashier+kitchen → both, primary pos (console>pos>kds order)", () => {
    expect(surfaceAccess(["orders.settle", "kds.operate"])).toEqual({ allowed: ["pos", "kds"], primary: "pos" });
  });
  it("no permissions → nothing", () => {
    expect(surfaceAccess([])).toEqual({ allowed: [], primary: null });
  });
});
