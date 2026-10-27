import { describe, expect, it } from "vitest";
import {
  InvalidSubscriptionTransition,
  PLAN_CATALOGUE,
  canTransition,
  limitBlockers,
  nextSubscriptionStatus,
  saasInvoiceAmounts,
  tenantStatusFor,
  withinLimit,
} from "./growth";

describe("subscription state machine", () => {
  it("walks trial → active → past_due → suspended → active", () => {
    let s = nextSubscriptionStatus("TRIAL", "PAYMENT_SUCCEEDED");
    expect(s).toBe("ACTIVE");
    s = nextSubscriptionStatus(s, "PAYMENT_FAILED");
    expect(s).toBe("PAST_DUE");
    s = nextSubscriptionStatus(s, "GRACE_EXPIRED");
    expect(s).toBe("SUSPENDED");
    expect(nextSubscriptionStatus(s, "PAYMENT_SUCCEEDED")).toBe("ACTIVE");
  });

  it("suspends an unpaid trial and keeps ACTIVE on cancel until the period ends", () => {
    expect(nextSubscriptionStatus("TRIAL", "TRIAL_EXPIRED")).toBe("SUSPENDED");
    expect(nextSubscriptionStatus("ACTIVE", "CANCEL")).toBe("ACTIVE");
    expect(nextSubscriptionStatus("ACTIVE", "PERIOD_ENDED")).toBe("CANCELLED");
  });

  it("rejects impossible moves", () => {
    expect(canTransition("TRIAL", "GRACE_EXPIRED")).toBe(false);
    expect(() => nextSubscriptionStatus("SUSPENDED", "PAYMENT_FAILED")).toThrow(InvalidSubscriptionTransition);
    expect(() => nextSubscriptionStatus("CANCELLED", "TRIAL_EXPIRED")).toThrow(/CANCELLED/);
  });

  it("mirrors onto the tenant status (past_due keeps working)", () => {
    expect(tenantStatusFor("TRIAL")).toBe("TRIAL");
    expect(tenantStatusFor("PAST_DUE")).toBe("ACTIVE");
    expect(tenantStatusFor("CANCELLED")).toBe("SUSPENDED");
  });
});

describe("plan limits", () => {
  const starter = PLAN_CATALOGUE.find((p) => p.code === "starter")!.limits;

  it("allows up to the limit and treats null as unlimited", () => {
    expect(withinLimit(starter, { outlets: 0, terminals: 1, users: 4 }, "terminals")).toBe(true);
    expect(withinLimit(starter, { outlets: 0, terminals: 2, users: 4 }, "terminals")).toBe(false);
    expect(withinLimit({ ...starter, users: null }, { outlets: 0, terminals: 0, users: 9999 }, "users")).toBe(true);
  });

  it("lists downgrade blockers", () => {
    expect(limitBlockers(starter, { outlets: 3, terminals: 2, users: 9 })).toEqual(["outlets", "users"]);
    expect(limitBlockers(starter, { outlets: 1, terminals: 2, users: 5 })).toEqual([]);
  });

  it("adds 18% GST in paise", () => {
    expect(saasInvoiceAmounts(2_499_00)).toEqual({ subtotal: 249900, taxAmount: 44982, total: 294882 });
  });
});
