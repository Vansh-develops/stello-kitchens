import { expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { PlatformAdminGuard } from "../src/common/platform-admin.guard";

function ctx(user: unknown) {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
}

it("allows a platform admin", () => {
  expect(new PlatformAdminGuard().canActivate(ctx({ isPlatformAdmin: true }))).toBe(true);
});
it("denies a normal user", () => {
  expect(() => new PlatformAdminGuard().canActivate(ctx({ isPlatformAdmin: false }))).toThrow(ForbiddenException);
});
it("denies when there is no user", () => {
  expect(() => new PlatformAdminGuard().canActivate(ctx(undefined))).toThrow(ForbiddenException);
});
