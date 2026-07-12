import { expect, it } from "vitest";
import { testPrisma } from "./db";

it("connects to the test database and starts empty", async () => {
  const tenants = await testPrisma.tenant.count();
  expect(tenants).toBe(0);
});
