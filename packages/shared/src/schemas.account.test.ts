import { describe, expect, it } from "vitest";
import { SignupSchema, ResetPasswordSchema, CreateInviteSchema, AcceptInviteSchema } from "./schemas";
describe("account schemas", () => {
  it("SignupSchema requires valid email + password>=8", () => {
    expect(SignupSchema.safeParse({ restaurantName: "Cafe", ownerName: "O", email: "a@b.com", password: "secret12" }).success).toBe(true);
    expect(SignupSchema.safeParse({ restaurantName: "X", ownerName: "O", email: "x", password: "short" }).success).toBe(false);
  });
  it("ResetPasswordSchema requires token + newPassword>=8", () => {
    expect(ResetPasswordSchema.safeParse({ token: "t", newPassword: "secret12" }).success).toBe(true);
    expect(ResetPasswordSchema.safeParse({ token: "", newPassword: "123" }).success).toBe(false);
  });
  it("invite schemas validate", () => {
    expect(CreateInviteSchema.safeParse({ email: "a@b.com", roleId: "r1" }).success).toBe(true);
    expect(AcceptInviteSchema.safeParse({ token: "t", name: "N", password: "secret12" }).success).toBe(true);
  });
});
