import { expect, it } from "vitest";
import { testPrisma } from "./db";
it("stores PendingSignup and AuthToken rows", async () => {
  const ps = await testPrisma.pendingSignup.create({
    data: { email: "s@x.com", passwordHash: "h", restaurantName: "R", ownerName: "O", tokenHash: "th", expiresAt: new Date(Date.now()+3600e3) },
  });
  expect(ps.email).toBe("s@x.com");
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const tok = await testPrisma.authToken.create({
    data: { type: "INVITE", tenantId: t.id, email: "i@x.com", tokenHash: "th2", expiresAt: new Date(Date.now()+3600e3) },
  });
  expect(tok.type).toBe("INVITE");
});
