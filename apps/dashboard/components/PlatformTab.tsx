"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatINR, type PlanDto, type PlatformSubscriptionActionInput, type PlatformSubscriptionRowDto } from "@stello/shared";
import { growthApi } from "@/lib/growth-api";

const rupees = (paise: number) => formatINR(paise / 100);
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";

// Platform super-admin: every tenant's Stello subscription, MRR, and manual
// lifecycle actions (trial extension, suspend/reactivate, comp plan changes).
export function PlatformTab() {
  const [rows, setRows] = useState<PlatformSubscriptionRowDto[]>([]);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [filter, setFilter] = useState<string>("ALL");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editPlan, setEditPlan] = useState<PlanDto | null>(null);

  const reload = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([growthApi.platformSubscriptions(), growthApi.platformPlans()]);
      setRows(r);
      setPlans(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tenants");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (tenantId: string, body: PlatformSubscriptionActionInput, ok: string) => {
    try {
      await growthApi.platformAction(tenantId, body);
      setMessage(ok);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const totals = useMemo(() => {
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      mrr: rows.reduce((a, r) => a + r.mrr, 0),
      active: by("ACTIVE"),
      trial: by("TRIAL"),
      pastDue: by("PAST_DUE"),
      suspended: by("SUSPENDED") + by("CANCELLED"),
    };
  }, [rows]);

  const visible = rows.filter(
    (r) => (filter === "ALL" || r.status === filter) && r.tenantName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Platform · subscriptions</h1>
        <button
          className="btn-ghost sm"
          onClick={async () => {
            try {
              const r = await growthApi.platformRunCycle();
              setMessage(`Lifecycle sweep: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ")}`);
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Sweep failed");
            }
          }}
        >
          Run lifecycle sweep
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}

      <div className="inv-stats billing-stats">
        <div className="stat"><span className="stat-label">MRR (ex-GST)</span><span className="stat-value">{rupees(totals.mrr)}</span></div>
        <div className="stat"><span className="stat-label">Active</span><span className="stat-value">{totals.active}</span></div>
        <div className="stat"><span className="stat-label">Trials</span><span className="stat-value">{totals.trial}</span></div>
        <div className={`stat ${totals.pastDue ? "warn" : ""}`}><span className="stat-label">Past due</span><span className="stat-value">{totals.pastDue}</span></div>
        <div className="stat"><span className="stat-label">Suspended / cancelled</span><span className="stat-value">{totals.suspended}</span></div>
      </div>

      <div className="platform-filters">
        <input placeholder="Search tenants" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["ALL", "TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"].map((s) => (
            <option key={s} value={s}>{s === "ALL" ? "All statuses" : s}</option>
          ))}
        </select>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Renews / ends</th>
              <th className="num">Outlets</th>
              <th className="num">Terminals</th>
              <th className="num">Users</th>
              <th className="num">MRR</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.tenantId} className={r.status === "PAST_DUE" || r.status === "SUSPENDED" ? "low" : ""}>
                <td className="strong">{r.tenantName}</td>
                <td>
                  <select
                    value={r.planCode}
                    onChange={(e) => act(r.tenantId, { action: "change_plan", planCode: e.target.value }, `${r.tenantName} moved to ${e.target.value}`)}
                  >
                    {plans.map((p) => (
                      <option key={p.code} value={p.code}>{p.name}</option>
                    ))}
                  </select>
                </td>
                <td><span className={`inv-status s-${r.status.toLowerCase()}`}>{r.status}</span>{r.openInvoices > 0 && <span className="faint"> · {r.openInvoices} unpaid</span>}</td>
                <td>
                  {r.status === "TRIAL" ? `trial ${date(r.trialEndsAt)}` : r.status === "PAST_DUE" ? `grace ${date(r.graceEndsAt)}` : date(r.currentPeriodEnd)}
                </td>
                {(["outlets", "terminals", "users"] as const).map((k) => (
                  <td key={k} className="num mono">
                    {r.usage[k]}/{r.limits[k] ?? "∞"}
                  </td>
                ))}
                <td className="num mono">{rupees(r.mrr)}</td>
                <td className="row-actions">
                  {(r.status === "TRIAL" || r.status === "SUSPENDED") && (
                    <button className="btn-ghost sm" onClick={() => act(r.tenantId, { action: "extend_trial", days: 14 }, `Trial extended for ${r.tenantName}`)}>
                      +14d trial
                    </button>
                  )}
                  {r.status === "SUSPENDED" || r.status === "CANCELLED" || r.status === "PAST_DUE" ? (
                    <button className="btn-ghost sm" onClick={() => act(r.tenantId, { action: "reactivate" }, `${r.tenantName} reactivated`)}>
                      Reactivate
                    </button>
                  ) : (
                    <button className="btn-ghost sm danger" onClick={() => act(r.tenantId, { action: "suspend" }, `${r.tenantName} suspended`)}>
                      Suspend
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={9} className="faint">No tenants match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="section-head">
        <h3>Plan catalogue</h3>
      </div>
      <div className="plan-grid">
        {plans.map((p) => (
          <div key={p.code} className={`plan-card ${p.isActive ? "" : "inactive"}`}>
            <div className="plan-name">{p.name} <span className="faint mono">{p.code}</span></div>
            <div className="plan-price">{rupees(p.priceMonthly)}<span> /month</span></div>
            <ul className="plan-limits">
              <li>{p.limits.outlets ?? "∞"} outlets · {p.limits.terminals ?? "∞"} terminals · {p.limits.users ?? "∞"} users</li>
              <li>{p.features.length} modules{p.providerPlanIds?.MONTHLY ? " · Razorpay linked" : ""}</li>
            </ul>
            <button className="btn-ghost sm" onClick={() => setEditPlan(p)}>Edit</button>
          </div>
        ))}
      </div>

      {editPlan && (
        <PlanEditor
          plan={editPlan}
          onClose={() => setEditPlan(null)}
          onSaved={async () => {
            setEditPlan(null);
            setMessage("Plan saved");
            await reload();
          }}
        />
      )}
    </div>
  );
}

const ALL_FEATURES = [
  "pos", "kds", "scan_order", "inventory", "crm", "loyalty", "aggregators", "einvoice", "central_kitchen", "chain_menu",
];

function PlanEditor({ plan, onClose, onSaved }: { plan: PlanDto; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(plan.name);
  const [monthly, setMonthly] = useState(String(plan.priceMonthly / 100));
  const [yearly, setYearly] = useState(String(plan.priceYearly / 100));
  const [limits, setLimits] = useState({
    outlets: plan.limits.outlets === null ? "" : String(plan.limits.outlets),
    terminals: plan.limits.terminals === null ? "" : String(plan.limits.terminals),
    users: plan.limits.users === null ? "" : String(plan.limits.users),
  });
  const [features, setFeatures] = useState(new Set<string>(plan.features));
  const [isActive, setIsActive] = useState(plan.isActive);
  const [rzpMonthly, setRzpMonthly] = useState(plan.providerPlanIds?.MONTHLY ?? "");
  const [rzpYearly, setRzpYearly] = useState(plan.providerPlanIds?.YEARLY ?? "");
  const [error, setError] = useState<string | null>(null);

  const lim = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v))));
  const save = async () => {
    try {
      await growthApi.platformUpdatePlan(plan.code, {
        name,
        priceMonthly: Math.round(Number(monthly) * 100),
        priceYearly: Math.round(Number(yearly) * 100),
        limits: { outlets: lim(limits.outlets), terminals: lim(limits.terminals), users: lim(limits.users) },
        features: [...features],
        isActive,
        providerPlanIds: { MONTHLY: rzpMonthly.trim() || undefined, YEARLY: rzpYearly.trim() || undefined },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Edit plan · {plan.code}</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="field-row">
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field short"><span>₹ / month</span><input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></label>
            <label className="field short"><span>₹ / year</span><input inputMode="decimal" value={yearly} onChange={(e) => setYearly(e.target.value)} /></label>
          </div>
          <div className="field-row">
            {(["outlets", "terminals", "users"] as const).map((k) => (
              <label key={k} className="field short">
                <span>{k} (blank = ∞)</span>
                <input inputMode="numeric" value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="chip-row">
            {ALL_FEATURES.map((f) => (
              <label key={f} className="chk">
                <input
                  type="checkbox"
                  checked={features.has(f)}
                  onChange={(e) => {
                    const next = new Set(features);
                    if (e.target.checked) next.add(f);
                    else next.delete(f);
                    setFeatures(next);
                  }}
                />{" "}
                {f}
              </label>
            ))}
          </div>
          <div className="field-row">
            <label className="field"><span>Razorpay plan id (monthly)</span><input value={rzpMonthly} onChange={(e) => setRzpMonthly(e.target.value)} placeholder="plan_…" /></label>
            <label className="field"><span>Razorpay plan id (yearly)</span><input value={rzpYearly} onChange={(e) => setRzpYearly(e.target.value)} placeholder="plan_…" /></label>
          </div>
          <label className="chk"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Offered to tenants</label>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save plan</button>
        </div>
      </div>
    </div>
  );
}
