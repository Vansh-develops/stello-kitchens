"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AggregatorSyncLogDto,
  EInvoiceProfileDto,
  LowStockAlertDto,
  LowStockRecipient,
  MessagingChannel,
  MessagingConfigDto,
  MessagingPurpose,
  OptOutDto,
  OutboxMessageDto,
  UnresolvedRefundDto,
} from "@stello/shared";
import { integrationsApi as api } from "@/lib/integrations-api";

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const PURPOSES: { key: MessagingPurpose; label: string; hint: string }[] = [
  { key: "OTP", label: "Loyalty OTP", hint: "var: otp" },
  { key: "CAMPAIGN", label: "Campaigns", hint: "var1: message" },
  { key: "LOW_STOCK", label: "Low-stock alert", hint: "vars: material, stock, reorder level, outlet" },
];
const CHANNELS: MessagingChannel[] = ["WHATSAPP", "SMS", "EMAIL"];
const OUTBOX_TONE: Record<string, string> = { QUEUED: "muted", SENDING: "info", SENT: "info", DELIVERED: "good", READ: "good", FAILED: "bad", SKIPPED: "muted" };

/**
 * Integrations console: messaging senders/templates (MSG91, WhatsApp, SMTP),
 * low-stock alert recipients, opt-outs, delivery log, GST e-invoice seller
 * details, aggregator sync (UrbanPiper/ONDC) and refund reconciliation.
 */
export function IntegrationsTab({ outletId }: { outletId: string }) {
  const [cfg, setCfg] = useState<MessagingConfigDto | null>(null);
  const [profile, setProfile] = useState<EInvoiceProfileDto | null>(null);
  const [alerts, setAlerts] = useState<LowStockAlertDto[]>([]);
  const [optOuts, setOptOuts] = useState<OptOutDto[]>([]);
  const [outbox, setOutbox] = useState<OutboxMessageDto[]>([]);
  const [syncLog, setSyncLog] = useState<AggregatorSyncLogDto[]>([]);
  const [refunds, setRefunds] = useState<UnresolvedRefundDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [platform, setPlatform] = useState("URBANPIPER");
  const [newOptOut, setNewOptOut] = useState({ phone: "", channel: "ALL" as "ALL" | MessagingChannel });
  const [newRecipient, setNewRecipient] = useState({ name: "", phone: "", email: "", channels: ["WHATSAPP"] as MessagingChannel[] });
  const [test, setTest] = useState({ channel: "SMS" as MessagingChannel, purpose: "CAMPAIGN" as MessagingPurpose, to: "" });

  const reload = useCallback(async () => {
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) => p.then(set).catch(() => undefined);
    try {
      await Promise.all([
        api.messagingConfig().then(setCfg),
        settle(api.einvoiceProfile(outletId), setProfile),
        settle(api.lowStockAlerts(outletId), setAlerts),
        settle(api.optOuts(), setOptOuts),
        settle(api.outbox(), setOutbox),
        settle(api.syncLog(outletId), setSyncLog),
        settle(api.unresolvedRefunds(outletId), setRefunds),
      ]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load integrations");
    }
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setNotice(ok);
      await reload();
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const saveCfg = (next: MessagingConfigDto) => {
    const { transports: _t, ...input } = next;
    void run(async () => setCfg(await api.saveMessagingConfig(input)), "Messaging settings saved");
  };
  const setTemplate = (purpose: MessagingPurpose, channel: "sms" | "whatsapp", field: string, value: string) => {
    if (!cfg) return;
    const cur = cfg.templates[purpose] ?? {};
    const block = { ...(cur[channel] ?? {}), [field]: value } as Record<string, string>;
    const cleaned = channel === "sms" ? (block.templateId ? block : undefined) : block.name ? { language: "en", ...block } : undefined;
    setCfg({ ...cfg, templates: { ...cfg.templates, [purpose]: { ...cur, [channel]: cleaned } } });
  };

  const addRecipient = () => {
    if (!cfg) return;
    const r: LowStockRecipient = {
      name: newRecipient.name.trim(),
      ...(newRecipient.phone.trim() ? { phone: newRecipient.phone.trim() } : {}),
      ...(newRecipient.email.trim() ? { email: newRecipient.email.trim() } : {}),
      channels: newRecipient.channels,
    };
    saveCfg({ ...cfg, lowStockRecipients: [...cfg.lowStockRecipients, r] });
    setNewRecipient({ name: "", phone: "", email: "", channels: ["WHATSAPP"] });
  };

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Integrations</h1>
        <button className="btn-ghost sm" onClick={() => void reload()}>Refresh</button>
      </div>
      <p className="hint wide">
        Real providers are switched on by server credentials. Where a provider is not configured its messages are only
        logged (shown as <em>log</em> / <em>mock</em> below) — nothing reaches customers.
      </p>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {notice && <div className="banner-ok" onClick={() => setNotice(null)}>{notice}</div>}

      {cfg && (
        <div className="kpi-row">
          <div className="kpi-card"><span className="kpi-label">SMS</span><span className="kpi-value">{cfg.transports.sms}</span></div>
          <div className="kpi-card"><span className="kpi-label">WhatsApp</span><span className="kpi-value">{cfg.transports.whatsapp}</span></div>
          <div className="kpi-card"><span className="kpi-label">Email</span><span className="kpi-value">{cfg.transports.email}</span></div>
          <div className="kpi-card"><span className="kpi-label">GST e-invoice</span><span className="kpi-value">{profile?.provider ?? "—"}</span></div>
        </div>
      )}

      <div className="mkt-grid">
        {/* ---------- Messaging ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">Messaging</h2>
          {cfg && (
            <div className="mkt-form">
              <div className="field-row">
                {(["smsEnabled", "whatsappEnabled", "emailEnabled"] as const).map((k) => (
                  <button key={k} className={`chan-active ${cfg[k] ? "on" : ""}`} onClick={() => setCfg({ ...cfg, [k]: !cfg[k] })}>
                    {k.replace("Enabled", "").toUpperCase()} {cfg[k] ? "on" : "off"}
                  </button>
                ))}
              </div>
              <div className="field-row">
                <label className="field">
                  <span>OTP over</span>
                  <select value={cfg.otpChannel} onChange={(e) => setCfg({ ...cfg, otpChannel: e.target.value as "SMS" | "WHATSAPP" })}>
                    <option value="SMS">SMS (MSG91)</option>
                    <option value="WHATSAPP">WhatsApp</option>
                  </select>
                </label>
                <label className="field short">
                  <span>Msgs / minute</span>
                  <input type="number" min={1} value={cfg.ratePerMinute} onChange={(e) => setCfg({ ...cfg, ratePerMinute: Number(e.target.value) || 1 })} />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>SMS sender id (DLT header)</span>
                  <input value={cfg.smsSenderId ?? ""} maxLength={6} placeholder="STELLO" onChange={(e) => setCfg({ ...cfg, smsSenderId: e.target.value.toUpperCase() || null })} />
                </label>
                <label className="field">
                  <span>WhatsApp phone number id</span>
                  <input value={cfg.whatsappPhoneNumberId ?? ""} placeholder="platform default" onChange={(e) => setCfg({ ...cfg, whatsappPhoneNumberId: e.target.value.trim() || null })} />
                </label>
              </div>
              {PURPOSES.map((p) => (
                <div key={p.key}>
                  <h3 className="mkt-h" style={{ fontSize: "0.95rem" }}>{p.label} <span className="faint">({p.hint})</span></h3>
                  <div className="field-row">
                    <input placeholder="MSG91 template id" value={cfg.templates[p.key]?.sms?.templateId ?? ""} onChange={(e) => setTemplate(p.key, "sms", "templateId", e.target.value.trim())} />
                    <input placeholder="DLT template id" value={cfg.templates[p.key]?.sms?.dltTemplateId ?? ""} onChange={(e) => setTemplate(p.key, "sms", "dltTemplateId", e.target.value.trim())} />
                  </div>
                  <div className="field-row">
                    <input placeholder="WhatsApp template name" value={cfg.templates[p.key]?.whatsapp?.name ?? ""} onChange={(e) => setTemplate(p.key, "whatsapp", "name", e.target.value.trim())} />
                    <input placeholder="lang (en)" style={{ maxWidth: 90 }} value={cfg.templates[p.key]?.whatsapp?.language ?? ""} onChange={(e) => setTemplate(p.key, "whatsapp", "language", e.target.value.trim())} />
                  </div>
                </div>
              ))}
              <button className="btn-primary sm" onClick={() => saveCfg(cfg)}>Save messaging settings</button>

              <h3 className="mkt-h" style={{ fontSize: "0.95rem" }}>Send a test</h3>
              <div className="field-row">
                <select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value as MessagingChannel })}>
                  {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                </select>
                <select value={test.purpose} onChange={(e) => setTest({ ...test, purpose: e.target.value as MessagingPurpose })}>
                  {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div className="field-row">
                <input placeholder={test.channel === "EMAIL" ? "email" : "mobile"} value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} />
                <button className="btn-ghost sm" disabled={test.to.trim().length < 5} onClick={() => void run(() => api.testMessage({ ...test, to: test.to.trim() }), "Test message sent")}>Send</button>
              </div>
            </div>
          )}
        </section>

        {/* ---------- Low stock ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">Low-stock alerts</h2>
          {cfg && (
            <div className="mkt-form">
              <button className={`chan-active ${cfg.lowStockEnabled ? "on" : ""}`} onClick={() => saveCfg({ ...cfg, lowStockEnabled: !cfg.lowStockEnabled })}>
                Staff alerts {cfg.lowStockEnabled ? "on" : "off"}
              </button>
              {cfg.lowStockRecipients.map((r, i) => (
                <div key={`${r.name}-${i}`} className="cmp-meta">
                  <span className="cmp-name">{r.name}</span>
                  <span className="faint">{[r.phone, r.email].filter(Boolean).join(" · ")}</span>
                  {r.channels.map((c) => <span key={c} className="plat-badge">{c}</span>)}
                  <button className="text-btn danger" onClick={() => saveCfg({ ...cfg, lowStockRecipients: cfg.lowStockRecipients.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              ))}
              <div className="field-row">
                <input placeholder="Name" value={newRecipient.name} onChange={(e) => setNewRecipient({ ...newRecipient, name: e.target.value })} />
                <input placeholder="Mobile" value={newRecipient.phone} onChange={(e) => setNewRecipient({ ...newRecipient, phone: e.target.value })} />
              </div>
              <div className="field-row">
                <input placeholder="Email (optional)" value={newRecipient.email} onChange={(e) => setNewRecipient({ ...newRecipient, email: e.target.value })} />
              </div>
              <div className="chip-select">
                {CHANNELS.map((c) => (
                  <button
                    key={c}
                    className={`select-chip ${newRecipient.channels.includes(c) ? "on" : ""}`}
                    onClick={() =>
                      setNewRecipient({
                        ...newRecipient,
                        channels: newRecipient.channels.includes(c) ? newRecipient.channels.filter((x) => x !== c) : [...newRecipient.channels, c],
                      })
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
              <button
                className="btn-primary sm"
                disabled={!newRecipient.name.trim() || !newRecipient.channels.length || (!newRecipient.phone.trim() && !newRecipient.email.trim())}
                onClick={addRecipient}
              >
                Add recipient
              </button>
            </div>
          )}
          <div className="section-head">
            <h3>Recent alerts</h3>
            <button className="btn-ghost sm" onClick={() => void run(() => api.checkLowStock(outletId), "Stock checked")}>Check now</button>
          </div>
          <table className="data-table">
            <tbody>
              {alerts.slice(0, 12).map((a) => (
                <tr key={a.id}>
                  <td className="mono faint">{time(a.createdAt)}</td>
                  <td>{a.materialName}</td>
                  <td className="num mono">{a.stockQty} / {a.reorderLevel} {a.unit}</td>
                  <td>
                    {a.acknowledgedAt ? (
                      <span className="status-pill muted">seen</span>
                    ) : (
                      <button className="text-btn" onClick={() => void run(() => api.ackLowStock(outletId, a.id))}>Acknowledge</button>
                    )}
                  </td>
                </tr>
              ))}
              {alerts.length === 0 && <tr><td className="empty">No low-stock crossings yet.</td></tr>}
            </tbody>
          </table>
        </section>

        {/* ---------- Opt-outs & delivery ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">Opt-outs</h2>
          <div className="mkt-form">
            <div className="field-row">
              <input placeholder="Mobile" value={newOptOut.phone} onChange={(e) => setNewOptOut({ ...newOptOut, phone: e.target.value })} />
              <select value={newOptOut.channel} onChange={(e) => setNewOptOut({ ...newOptOut, channel: e.target.value as "ALL" | MessagingChannel })}>
                <option value="ALL">All channels</option>
                <option value="SMS">SMS</option>
                <option value="WHATSAPP">WhatsApp</option>
              </select>
              <button className="btn-ghost sm" disabled={newOptOut.phone.replace(/\D/g, "").length < 10} onClick={() => void run(async () => { await api.addOptOut({ phone: newOptOut.phone.trim(), channel: newOptOut.channel }); setNewOptOut({ phone: "", channel: "ALL" }); })}>
                Opt out
              </button>
            </div>
          </div>
          <table className="data-table">
            <tbody>
              {optOuts.slice(0, 20).map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.phone}</td>
                  <td><span className="plat-badge">{o.channel}</span></td>
                  <td className="faint">{o.source === "WHATSAPP_STOP" ? "replied STOP" : o.source.toLowerCase()}</td>
                  <td><button className="text-btn" onClick={() => void run(() => api.removeOptOut(o.id))}>Remove</button></td>
                </tr>
              ))}
              {optOuts.length === 0 && <tr><td className="empty">Nobody has opted out.</td></tr>}
            </tbody>
          </table>

          <h2 className="mkt-h">Delivery log</h2>
          <table className="data-table">
            <tbody>
              {outbox.slice(0, 25).map((m) => (
                <tr key={m.id} title={m.error ?? ""}>
                  <td className="mono faint">{time(m.createdAt)}</td>
                  <td><span className="plat-badge">{m.channel}</span></td>
                  <td className="faint">{m.purpose.toLowerCase().replace("_", " ")}</td>
                  <td className="mono">{m.recipient}</td>
                  <td><span className={`status-pill ${OUTBOX_TONE[m.status] ?? "muted"}`}>{m.status.toLowerCase()}</span></td>
                </tr>
              ))}
              {outbox.length === 0 && <tr><td className="empty">No messages yet.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <div className="mkt-grid">
        {/* ---------- GST e-invoice seller ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">GST e-invoice seller details</h2>
          {profile && (
            <div className="mkt-form">
              <p className="hint">
                GSTIN {profile.gstin ?? "not set on the outlet"} · provider {profile.provider}
                {profile.live ? "" : " (mock — IRNs are not registered with the IRP)"}
              </p>
              <input placeholder="Legal name (as on GST registration)" value={profile.legalName} onChange={(e) => setProfile({ ...profile, legalName: e.target.value })} />
              <input placeholder="Address line 1" value={profile.address1} onChange={(e) => setProfile({ ...profile, address1: e.target.value })} />
              <input placeholder="Address line 2" value={profile.address2 ?? ""} onChange={(e) => setProfile({ ...profile, address2: e.target.value || null })} />
              <div className="field-row">
                <input placeholder="City" value={profile.location} onChange={(e) => setProfile({ ...profile, location: e.target.value })} />
                <input placeholder="Pincode" inputMode="numeric" value={profile.pincode || ""} onChange={(e) => setProfile({ ...profile, pincode: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
                <input placeholder="State code" style={{ maxWidth: 90 }} value={profile.stateCode} onChange={(e) => setProfile({ ...profile, stateCode: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
              </div>
              <button
                className="btn-primary sm"
                disabled={!profile.legalName.trim() || !profile.address1.trim() || !profile.location.trim() || profile.pincode < 100000 || profile.stateCode.length !== 2}
                onClick={() =>
                  void run(async () => {
                    const { gstin: _g, provider: _p, live: _l, ...input } = profile;
                    setProfile(await api.saveEinvoiceProfile(outletId, input));
                  }, "Seller details saved")
                }
              >
                Save seller details
              </button>
            </div>
          )}
        </section>

        {/* ---------- Aggregators ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">Aggregator sync</h2>
          <div className="mkt-form">
            <p className="hint">
              UrbanPiper relays Zomato, Swiggy and other platforms. ONDC catalogues are built to the public protocol and go live
              after ONDC onboarding. Item 86s are pushed automatically.
            </p>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="URBANPIPER">UrbanPiper (Zomato · Swiggy)</option>
              <option value="ONDC">ONDC</option>
            </select>
            <div className="field-row">
              <button className="btn-ghost sm" onClick={() => void run(() => api.pushMenu(outletId, platform), "Menu push queued")}>Push menu</button>
              <button className="btn-ghost sm" onClick={() => void run(() => api.pushStock(outletId, platform), "Item availability synced")}>Sync stock</button>
            </div>
            <div className="field-row">
              <button className="btn-ghost sm" onClick={() => void run(() => api.setStore(outletId, platform, true), "Store set online")}>Store online</button>
              <button className="btn-ghost sm" onClick={() => void run(() => api.setStore(outletId, platform, false, "Paused from Stello"), "Store set offline")}>Store offline</button>
            </div>
          </div>
          <table className="data-table">
            <tbody>
              {syncLog.slice(0, 15).map((l) => (
                <tr key={l.id} title={l.error ?? l.referenceId ?? ""}>
                  <td className="mono faint">{time(l.createdAt)}</td>
                  <td><span className={`plat-badge ${l.platform.toLowerCase()}`}>{l.platform}</span></td>
                  <td>{l.kind.toLowerCase().replace("_", " ")}</td>
                  <td><span className={`status-pill ${l.status === "OK" ? "good" : l.status === "ERROR" ? "bad" : "muted"}`}>{l.status.toLowerCase()}</span></td>
                </tr>
              ))}
              {syncLog.length === 0 && <tr><td className="empty">No syncs yet.</td></tr>}
            </tbody>
          </table>
        </section>

        {/* ---------- Refund reconciliation ---------- */}
        <section className="mkt-col">
          <h2 className="mkt-h">Refunds awaiting the gateway</h2>
          <p className="hint">
            Pending/unknown refunds keep their amount reserved until Razorpay confirms. Manual ones were returned outside the
            gateway (card machine, static UPI).
          </p>
          <table className="data-table">
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td className="mono faint">{time(r.createdAt)}</td>
                  <td className="num mono">{money(r.amount)}</td>
                  <td><span className={`status-pill ${r.status === "UNKNOWN" ? "bad" : "muted"}`}>{r.status.toLowerCase()}</span></td>
                  <td>
                    {r.status !== "MANUAL" && (
                      <button className="text-btn" onClick={() => void run(() => api.reconcileRefund(outletId, r.id), "Reconciled with Razorpay")}>Check now</button>
                    )}
                  </td>
                </tr>
              ))}
              {refunds.length === 0 && <tr><td className="empty">Nothing waiting.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
