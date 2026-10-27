"use client";

import { useCallback, useEffect, useState } from "react";
import type { BillingSettingsDto, BillingSettingsInput, OrderType } from "@stello/shared";
import { computeBill } from "@stello/shared";
import { request } from "@/lib/api";

const ORDER_TYPES: { key: OrderType; label: string }[] = [
  { key: "DINE_IN", label: "Dine-in" },
  { key: "TAKEAWAY", label: "Takeaway" },
  { key: "DELIVERY", label: "Delivery" },
];
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Dhaka", "Europe/London", "UTC"];
const money2 = (n: number) => `₹${n.toFixed(2)}`;

/** Outlet billing rules: service charge, round-off and the outlet time zone. */
export function BillingSettingsTab({ outletId }: { outletId: string }) {
  const [form, setForm] = useState<BillingSettingsInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await request<BillingSettingsDto>(`/outlets/${outletId}/billing-settings`);
      setForm({
        serviceChargeEnabled: s.serviceChargeEnabled,
        serviceChargePercent: s.serviceChargePercent,
        serviceChargeTaxable: s.serviceChargeTaxable,
        serviceChargeOrderTypes: s.serviceChargeOrderTypes,
        roundOffEnabled: s.roundOffEnabled,
        timezone: s.timezone,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing settings");
    }
  }, [outletId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form) return <div className="tab-pane">{error ? <div className="banner-error">{error}</div> : <p className="hint">Loading…</p>}</div>;

  const set = <K extends keyof BillingSettingsInput>(k: K, v: BillingSettingsInput[K]) => setForm({ ...form, [k]: v });
  const toggleType = (t: OrderType) =>
    set(
      "serviceChargeOrderTypes",
      form.serviceChargeOrderTypes.includes(t)
        ? form.serviceChargeOrderTypes.filter((x) => x !== t)
        : [...form.serviceChargeOrderTypes, t],
    );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await request<BillingSettingsDto>(`/outlets/${outletId}/billing-settings`, {
        method: "PUT",
        body: JSON.stringify({ ...form, serviceChargePercent: Math.round(form.serviceChargePercent * 100) / 100 }),
      });
      setMessage("Billing rules saved — running bills pick them up on their next change or at settlement.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  // Worked example on a ₹1,000 dine-in bill at 5% GST.
  const example = computeBill([{ lineTotalPaise: 100000 - 1, taxRatePercent: 5 }], {
    discountRupees: 0,
    serviceCharge: form.serviceChargeEnabled ? { percent: form.serviceChargePercent, taxable: form.serviceChargeTaxable } : null,
    roundOff: form.roundOffEnabled,
  });

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Billing rules</h1>
        <button className="btn-primary sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {message && <div className="banner-ok" onClick={() => setMessage(null)}>{message}</div>}

      <div className="fleet-list">
        <div className="device-card">
          <div className="dc-head">
            <div className="dc-title">
              <span className="dc-name">Service charge</span>
            </div>
          </div>
          <div className="dc-config">
            <label className="chk">
              <input type="checkbox" checked={form.serviceChargeEnabled} onChange={(e) => set("serviceChargeEnabled", e.target.checked)} />
              Charge a service charge
            </label>
            <label>
              Percent
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                value={form.serviceChargePercent}
                disabled={!form.serviceChargeEnabled}
                onChange={(e) => set("serviceChargePercent", Number(e.target.value) || 0)}
              />
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={form.serviceChargeTaxable}
                disabled={!form.serviceChargeEnabled}
                onChange={(e) => set("serviceChargeTaxable", e.target.checked)}
              />
              GST applies to the service charge
            </label>
            {ORDER_TYPES.map((t) => (
              <label key={t.key} className="chk">
                <input
                  type="checkbox"
                  checked={form.serviceChargeOrderTypes.includes(t.key)}
                  disabled={!form.serviceChargeEnabled}
                  onChange={() => toggleType(t.key)}
                />
                {t.label}
              </label>
            ))}
          </div>
          <p className="dc-noconfig">
            Charged on the food value after discounts. Staff with the “remove service charge” permission can waive it on a
            single bill with a reason; every removal is audit-logged.
          </p>
        </div>

        <div className="device-card">
          <div className="dc-head">
            <div className="dc-title">
              <span className="dc-name">Round-off &amp; time</span>
            </div>
          </div>
          <div className="dc-config">
            <label className="chk">
              <input type="checkbox" checked={form.roundOffEnabled} onChange={(e) => set("roundOffEnabled", e.target.checked)} />
              Round bills to the nearest rupee
            </label>
            <label>
              Outlet time zone
              <select value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {[...new Set([form.timezone, ...ZONES])].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="dc-noconfig">
            The round-off is recorded as its own line and in reports; payments must equal the rounded total. The time zone
            decides when items with a serving window (e.g. breakfast till 11:00) can be ordered.
          </p>
        </div>

        <div className="device-card">
          <div className="dc-head">
            <div className="dc-title">
              <span className="dc-name">Example · ₹999.99 dine-in at 5% GST</span>
            </div>
          </div>
          <div className="tax-rows">
            <div><span>Food</span><span className="mono">{money2(example.subtotal)}</span></div>
            <div><span>Service charge</span><span className="mono">{money2(example.serviceChargeAmount)}</span></div>
            <div><span>GST</span><span className="mono">{money2(example.taxAmount)}</span></div>
            <div><span>Round off</span><span className="mono">{money2(example.roundOff)}</span></div>
            <div className="tax-total"><span>Payable</span><span className="mono">{money2(example.total)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
