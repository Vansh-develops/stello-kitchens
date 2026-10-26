"use client";

import { useCallback, useEffect, useState } from "react";
import { formatINR, saasInvoiceAmounts, type BillingCycle, type PlanDto, type SubscriptionDto } from "@stello/shared";
import { growthApi } from "@/lib/growth-api";

const rupees = (paise: number) => formatINR(paise / 100);
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const daysUntil = (iso: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : 0);

const FEATURE_LABELS: Record<string, string> = {
  pos: "POS billing",
  kds: "Kitchen display",
  scan_order: "Scan & Order / kiosk",
  inventory: "Inventory & recipes",
  crm: "CRM & campaigns",
  loyalty: "Loyalty",
  aggregators: "Zomato / Swiggy",
  einvoice: "GST e-invoicing",
  central_kitchen: "Central kitchen",
  chain_menu: "Brand master menu",
};

const STATUS_LABEL: Record<SubscriptionDto["status"], string> = {
  TRIAL: "Free trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment due",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

// The restaurant's own Stello subscription: plan, usage against limits,
// plan changes and GST invoices.
export function BillingTab() {
  const [sub, setSub] = useState<SubscriptionDto | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPlan, setConfirmPlan] = useState<PlanDto | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await growthApi.subscription();
      setSub(s);
      setCycle(s.billingCycle);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<SubscriptionDto>, ok: string) => {
    setBusy(true);
    try {
      const s = await fn();
      setSub(s);
      setMessage(s.checkoutUrl ? "Complete the payment authorisation to activate your plan." : ok);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
      setConfirmPlan(null);
    }
  };

  if (!sub)
    return (
      <div className="tab-pane">
        {error ? <div className="banner-error">{error}</div> : <p className="empty">Loading billing…</p>}
      </div>
    );

  const live = sub.status === "ACTIVE" || sub.status === "PAST_DUE";
  const usageRows: { key: keyof SubscriptionDto["usage"]; label: string }[] = [
    { key: "outlets", label: "Outlets" },
    { key: "terminals", label: "Terminals" },
    { key: "users", label: "Users" },
  ];

  return (
    <div className="tab-pane billing-pane">
      <div className="pane-head">
        <h1>Billing &amp; plan</h1>
        <div className="seg-toggle" role="group" aria-label="Billing cycle">
          {(["MONTHLY", "YEARLY"] as const).map((c) => (
            <button key={c} className={cycle === c ? "active" : ""} onClick={() => setCycle(c)}>
              {c === "MONTHLY" ? "Monthly" : "Yearly · 2 months free"}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}

      <StatusBanner sub={sub} />
      {sub.checkoutUrl && (
        <div className="billing-banner warn">
          Payment authorisation pending.{" "}
          <a href={sub.checkoutUrl} target="_blank" rel="noreferrer">Open the secure payment page →</a>
        </div>
      )}

      <div className="inv-stats billing-stats">
        <div className="stat">
          <span className="stat-label">Plan</span>
          <span className="stat-value">{sub.plan.name}</span>
        </div>
        <div className={`stat ${sub.status === "PAST_DUE" || sub.status === "SUSPENDED" ? "warn" : ""}`}>
          <span className="stat-label">Status</span>
          <span className="stat-value">{STATUS_LABEL[sub.status]}</span>
        </div>
        {usageRows.map((u) => {
          const limit = sub.plan.limits[u.key];
          const full = limit !== null && sub.usage[u.key] >= limit;
          return (
            <div key={u.key} className={`stat ${full ? "warn" : ""}`}>
              <span className="stat-label">{u.label}</span>
              <span className="stat-value">
                {sub.usage[u.key]}
                <small> / {limit ?? "∞"}</small>
              </span>
            </div>
          );
        })}
      </div>

      <div className="section-head">
        <h3>Plans</h3>
      </div>
      <div className="plan-grid">
        {sub.plans.map((p) => {
          const current = p.code === sub.plan.code && live && sub.billingCycle === cycle && !sub.cancelAtPeriodEnd;
          const price = cycle === "YEARLY" ? p.priceYearly : p.priceMonthly;
          const label = current
            ? "Current plan"
            : live && p.code === sub.plan.code
              ? sub.cancelAtPeriodEnd && sub.billingCycle === cycle
                ? "Keep this plan"
                : "Switch billing cycle"
              : live
                ? `Switch to ${p.name}`
                : `Choose ${p.name}`;
          return (
            <div key={p.code} className={`plan-card ${p.code === sub.plan.code ? "current" : ""}`}>
              <div className="plan-name">{p.name}</div>
              <div className="plan-price">
                {rupees(price)}
                <span> /{cycle === "YEARLY" ? "year" : "month"} + GST</span>
              </div>
              <ul className="plan-limits">
                <li>{p.limits.outlets ?? "Unlimited"} outlet{p.limits.outlets === 1 ? "" : "s"}</li>
                <li>{p.limits.terminals ?? "Unlimited"} terminals</li>
                <li>{p.limits.users ?? "Unlimited"} staff logins</li>
              </ul>
              <ul className="plan-features">
                {p.features.map((f) => (
                  <li key={f}>{FEATURE_LABELS[f] ?? f}</li>
                ))}
              </ul>
              <button className={current ? "btn-ghost sm" : "btn-primary sm"} disabled={current || busy} onClick={() => setConfirmPlan(p)}>
                {label}
              </button>
            </div>
          );
        })}
      </div>

      <div className="section-head">
        <h3>Invoices</h3>
        {live && !sub.cancelAtPeriodEnd && (
          <button
            className="btn-ghost sm danger"
            disabled={busy}
            onClick={() => run(growthApi.cancelSubscription, "Your plan will end at the close of this billing period.")}
          >
            Cancel subscription
          </button>
        )}
      </div>
      {sub.invoices.length === 0 ? (
        <p className="empty">No invoices yet — your first invoice is raised when you choose a plan.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Period</th>
                <th>Plan</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sub.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.number}</td>
                  <td>
                    {date(i.periodStart)} – {date(i.periodEnd)}
                  </td>
                  <td>
                    {i.planCode} · {i.billingCycle === "YEARLY" ? "yearly" : "monthly"}
                  </td>
                  <td className="num mono">{rupees(i.total)}</td>
                  <td>
                    <span className={`inv-status s-${i.status.toLowerCase()}`}>{i.status}</span>
                  </td>
                  <td className="row-actions">
                    <button className="btn-ghost sm" onClick={() => setInvoiceId(i.id)}>View</button>
                    {(i.status === "OPEN" || i.status === "FAILED") && (
                      <button
                        className="btn-primary sm"
                        disabled={busy}
                        onClick={() => run(() => growthApi.payInvoice(i.id), "Payment received — thank you!")}
                      >
                        Pay now
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmPlan && (
        <div className="modal-scrim" onClick={() => setConfirmPlan(null)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{live ? "Change plan" : "Start subscription"}</h2>
              <button className="modal-x" onClick={() => setConfirmPlan(null)}>✕</button>
            </div>
            <div className="modal-body">
              <PlanSummary plan={confirmPlan} cycle={cycle} live={live} />
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setConfirmPlan(null)}>Back</button>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  run(() => growthApi.subscribe({ planCode: confirmPlan.code, billingCycle: cycle }), `You're on ${confirmPlan.name}.`)
                }
              >
                {busy ? "Working…" : live ? "Confirm change" : "Subscribe"}
              </button>
            </div>
          </div>
        </div>
      )}

      {invoiceId && <InvoiceView id={invoiceId} onClose={() => setInvoiceId(null)} />}
    </div>
  );
}

function StatusBanner({ sub }: { sub: SubscriptionDto }) {
  if (sub.status === "TRIAL") {
    const d = daysUntil(sub.trialEndsAt);
    return (
      <div className={`billing-banner ${d <= 3 ? "warn" : ""}`}>
        Free trial of <strong>{sub.plan.name}</strong> — {d > 0 ? `${d} day${d === 1 ? "" : "s"} left` : "ends today"} (
        {date(sub.trialEndsAt)}). Choose a plan to keep going without interruption.
      </div>
    );
  }
  if (sub.status === "PAST_DUE") {
    return (
      <div className="billing-banner crit">
        Your last payment failed. Service continues until <strong>{date(sub.graceEndsAt)}</strong> — pay the open
        invoice below to avoid suspension.
      </div>
    );
  }
  if (sub.status === "SUSPENDED" || sub.status === "CANCELLED") {
    return (
      <div className="billing-banner crit">
        Your subscription is {sub.status === "SUSPENDED" ? "suspended" : "cancelled"}. Choose a plan to reactivate.
      </div>
    );
  }
  return (
    <div className="billing-banner">
      {sub.cancelAtPeriodEnd ? "Ends" : "Renews"} on <strong>{date(sub.currentPeriodEnd)}</strong>
      {sub.cancelAtPeriodEnd
        ? " — choose your plan again to keep it."
        : ` · billed ${sub.billingCycle === "YEARLY" ? "yearly" : "monthly"}.`}
    </div>
  );
}

function PlanSummary({ plan, cycle, live }: { plan: PlanDto; cycle: BillingCycle; live: boolean }) {
  const a = saasInvoiceAmounts(cycle === "YEARLY" ? plan.priceYearly : plan.priceMonthly);
  return (
    <>
      <p className="hint">
        {live
          ? "The new plan applies immediately; your next renewal invoice is billed at the new price."
          : "Your first invoice is raised now and collected through our payment partner."}
      </p>
      <table className="mini-table">
        <tbody>
          <tr>
            <td>
              {plan.name} · {cycle === "YEARLY" ? "1 year" : "1 month"}
            </td>
            <td className="num">{rupees(a.subtotal)}</td>
          </tr>
          <tr>
            <td>GST 18%</td>
            <td className="num">{rupees(a.taxAmount)}</td>
          </tr>
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong>{rupees(a.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function InvoiceView({ id, onClose }: { id: string; onClose: () => void }) {
  const [inv, setInv] = useState<Awaited<ReturnType<typeof growthApi.invoice>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    growthApi
      .invoice(id)
      .then(setInv)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load invoice"));
  }, [id]);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal saas-invoice" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Tax invoice</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="banner-error">{error}</div>}
          {!inv ? (
            !error && <p className="empty">Loading…</p>
          ) : (
            <>
              <div className="si-head">
                <div>
                  <strong>Stello Technologies</strong>
                  <div className="faint">SaaS subscription · SAC 998314</div>
                </div>
                <div className="si-meta">
                  <div className="mono">{inv.number}</div>
                  <div>{date(inv.periodStart)}</div>
                </div>
              </div>
              <div>
                Billed to: <strong>{inv.tenantName}</strong>
              </div>
              <table className="mini-table">
                <tbody>
                  <tr>
                    <td>
                      {inv.planCode} plan · {date(inv.periodStart)} – {date(inv.periodEnd)}
                    </td>
                    <td className="num">{rupees(inv.subtotal)}</td>
                  </tr>
                  <tr>
                    <td>GST @ 18%</td>
                    <td className="num">{rupees(inv.taxAmount)}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    <td className="num">
                      <strong>{rupees(inv.total)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="faint">
                Status: {inv.status}
                {inv.paidAt ? ` · paid ${date(inv.paidAt)}` : ""}
                {inv.providerRef ? ` · ref ${inv.providerRef}` : ""}
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" disabled={!inv} onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
    </div>
  );
}
