import { describe, expect, it } from "vitest";
import { UpdateOutletSchema, CreateAreaSchema, CreateTablesSchema } from "./schemas";

describe("onboarding schemas", () => {
  it("UpdateOutletSchema accepts partial + empty", () => {
    expect(UpdateOutletSchema.safeParse({}).success).toBe(true);
    expect(UpdateOutletSchema.safeParse({ name: "Main", gstin: "29ABCDE1234F1Z5" }).success).toBe(true);
  });
  it("CreateAreaSchema requires a name", () => {
    expect(CreateAreaSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateAreaSchema.safeParse({ name: "Main" }).success).toBe(true);
  });
  it("CreateTablesSchema bounds count 1..50", () => {
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 0 }).success).toBe(false);
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 51 }).success).toBe(false);
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 8 }).success).toBe(true);
  });
});
