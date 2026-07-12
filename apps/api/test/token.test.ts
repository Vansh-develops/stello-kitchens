import { expect, it } from "vitest";
import { newToken, hashToken } from "../src/common/token";
it("newToken returns a raw token and its stable hash", () => {
  const { raw, hash } = newToken();
  expect(raw.length).toBeGreaterThan(20);
  expect(hash).toBe(hashToken(raw));
  expect(hash).not.toBe(raw);
});
