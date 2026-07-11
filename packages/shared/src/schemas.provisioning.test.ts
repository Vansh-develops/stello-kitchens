import { describe, expect, it } from "vitest";
import { ProvisionTenantSchema } from "./schemas";

describe("ProvisionTenantSchema", () => {
  it("accepts a valid payload", () => {
    const r = ProvisionTenantSchema.safeParse({
      restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "a@b.com", ownerPassword: "secret12",
    });
    expect(r.success).toBe(true);
  });
  it("rejects a short password and a bad email", () => {
    expect(ProvisionTenantSchema.safeParse({
      restaurantName: "X", ownerName: "Y", ownerEmail: "nope", ownerPassword: "123",
    }).success).toBe(false);
  });
});
