"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PERMISSIONS,
  WEBHOOK_EVENTS,
  hasPermission,
  missingPermissions,
  type ApiKeyDto,
  type AuthUser,
  type OutletDto,
  type WebhookDeliveryDto,
  type WebhookDto,
  type WebhookEventType,
} from "@stello/shared";
import { platformApi } from "@/lib/platform-api";
import "./platform.css";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/** Scopes worth offering an integration (read-mostly). */
const KEY_SCOPES = ["orders.view", "reports.view", "menu.stock", "inventory.manage"];

function Secret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pf-stack">
      <p className="pf-owner-note">{label} Copy it now: it won&apos;t be shown again.</p>
      <div className="pf-secret">
        <code>{value}</code>
        <button
          className="btn-ghost sm"
          onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => undefined)}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="pf-row"><button className="text-btn" onClick={onDone}>Done</button></div>
    </div>
  );
}

/** Tenant API keys (scoped, hashed, last-used) and outbound webhooks with delivery log + test-send. */
export function IntegrationsTab({ user, outlets }: { user: AuthUser; outlets: OutletDto[] }) {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [hooks, setHooks] = useState<WebhookDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; value: string } | null>(null);

  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(["orders.view", "reports.view"]);
  const [keyOutlet, setKeyOutlet] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const [hookUrl, setHookUrl] = useState("");
  const [hookDesc, setHookDesc] = useState("");
  const [hookEvents, setHookEvents] = useState<WebhookEventType[]>(["order.settled"]);
  const [hookOutlet, setHookOutlet] = useState("");
  const [openHook, setOpenHook] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [openDelivery, setOpenDelivery] = useState<WebhookDeliveryDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const allowed = hasPermission(user.permissions, "integrations.manage");

  const load = useCallback(async () => {
    try {
      const [k, h] = await Promise.all([platformApi.apiKeys(), platformApi.webhooks()]);
      setKeys(k);
      setHooks(h);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations");
    }
  }, []);

  const loadDeliveries = useCallback(async (id: string, after?: string) => {
    const page = await platformApi.webhookDeliveries(id, after);
    setDeliveries((prev) => (after ? [...prev, ...page.items] : page.items));
    setDeliveryCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  useEffect(() => {
    setOpenDelivery(null);
    if (openHook) void loadDeliveries(openHook).catch((e) => setError(e instanceof Error ? e.message : "Failed to load deliveries"));
  }, [openHook, loadDeliveries]);

  if (!allowed) return <div className="pf-access">You need the “API keys &amp; webhooks” permission to see this page.</div>;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const createKey = () =>
    run(async () => {
      const k = await platformApi.createApiKey({ name: keyName.trim(), permissions: keyScopes, outletIds: keyOutlet ? [keyOutlet] : null });
      setRevealed({ label: `API key “${k.name}” created.`, value: k.key });
      setKeyName("");
    });

  const createHook = () =>
    run(async () => {
      const h = await platformApi.createWebhook({ url: hookUrl.trim(), description: hookDesc.trim() || undefined, events: hookEvents, outletId: hookOutlet || null, isActive: true });
      setRevealed({ label: `Webhook created. Use this signing secret to verify the Stello-Signature header.`, value: h.secret });
      setHookUrl("");
      setHookDesc("");
      setOpenHook(h.id);
    });

  const scopeOptions = [...new Set([...KEY_SCOPES, ...PERMISSIONS.map((p) => p.key)])].filter(
    (k) => missingPermissions(user.permissions, [k]).length === 0,
  );
  const outletName = (id: string | null) => (id ? (outlets.find((o) => o.id === id)?.name ?? "1 outlet") : "All outlets");
  const hook = hooks.find((h) => h.id === openHook) ?? null;

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>API &amp; webhooks</h1>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      <p className="hint wide">
        Connect accounting, BI or delivery tools. API keys call the public API and the MCP server with only the
        permissions you give them; webhooks push events to your systems, signed with HMAC-SHA256. See
        docs/PUBLIC-API.md for endpoints and signature checks.
      </p>
      {revealed && <div className="report-card"><Secret label={revealed.label} value={revealed.value} onDone={() => setRevealed(null)} /></div>}

      <div className="pf-grid">
        <div className="report-card pf-stack">
          <span className="card-title">API keys</span>
          <div className="pf-list">
            {keys.map((k) => (
              <div key={k.id} className="pf-item">
                <div className="pf-item-main">
                  <span className="pf-item-title">{k.name} <span className="pf-mono pf-faint">{k.prefix}…</span></span>
                  <span className="pf-item-sub">{k.permissions.join(", ")} · {outletName(k.outletIds?.[0] ?? null)}{k.outletIds && k.outletIds.length > 1 ? ` +${k.outletIds.length - 1}` : ""}</span>
                  <span className="pf-item-sub">Last used {when(k.lastUsedAt)}{k.expiresAt ? ` · expires ${when(k.expiresAt)}` : ""}</span>
                </div>
                {k.revokedAt ? (
                  <span className="status-pill muted">Revoked</span>
                ) : (
                  <button
                    className={`text-btn danger ${confirmRevoke === k.id ? "armed" : ""}`}
                    disabled={busy}
                    onClick={() => (confirmRevoke === k.id ? void run(async () => { await platformApi.revokeApiKey(k.id); setConfirmRevoke(null); }) : setConfirmRevoke(k.id))}
                  >
                    {confirmRevoke === k.id ? "Confirm revoke" : "Revoke"}
                  </button>
                )}
              </div>
            ))}
            {keys.length === 0 && <p className="empty pf-item">No API keys yet.</p>}
          </div>
          <div className="pf-stack">
            <label className="pf-label">Name<input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Tally sync, Claude assistant" maxLength={80} /></label>
            <span className="pf-label">Permissions</span>
            <div className="pf-chips">
              {scopeOptions.map((k) => (
                <button key={k} type="button" className={`pf-toggle-chip ${keyScopes.includes(k) ? "on" : ""}`} onClick={() => setKeyScopes((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}>
                  {PERMISSIONS.find((p) => p.key === k)?.label ?? k}
                </button>
              ))}
            </div>
            <label className="pf-label">Outlet
              <select value={keyOutlet} onChange={(e) => setKeyOutlet(e.target.value)}>
                <option value="">All outlets</option>
                {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <div className="pf-row end">
              <button className="btn-primary sm" disabled={busy || !keyName.trim() || keyScopes.length === 0} onClick={() => void createKey()}>Create key</button>
            </div>
          </div>
        </div>

        <div className="report-card pf-stack">
          <span className="card-title">Webhooks</span>
          <div className="pf-list">
            {hooks.map((h) => (
              <button key={h.id} className={`pf-item selectable ${openHook === h.id ? "active" : ""}`} onClick={() => setOpenHook(openHook === h.id ? null : h.id)}>
                <div className="pf-item-main">
                  <span className="pf-item-title">{h.url}</span>
                  <span className="pf-item-sub">{h.events.join(", ")} · {outletName(h.outletId)}</span>
                </div>
                <span className={`status-pill ${h.isActive ? "good" : "muted"}`}>{h.isActive ? "Active" : "Paused"}</span>
              </button>
            ))}
            {hooks.length === 0 && <p className="empty pf-item">No webhooks yet.</p>}
          </div>
          <div className="pf-stack">
            <label className="pf-label">Endpoint URL<input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://example.com/stello/webhook" /></label>
            <label className="pf-label">Description<input value={hookDesc} onChange={(e) => setHookDesc(e.target.value)} placeholder="optional" maxLength={200} /></label>
            <span className="pf-label">Events</span>
            <div className="pf-chips">
              {WEBHOOK_EVENTS.map((ev) => (
                <button key={ev.key} type="button" title={ev.description} className={`pf-toggle-chip ${hookEvents.includes(ev.key) ? "on" : ""}`} onClick={() => setHookEvents((s) => (s.includes(ev.key) ? s.filter((x) => x !== ev.key) : [...s, ev.key]))}>
                  {ev.key}
                </button>
              ))}
            </div>
            <label className="pf-label">Outlet
              <select value={hookOutlet} onChange={(e) => setHookOutlet(e.target.value)}>
                <option value="">All outlets</option>
                {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <div className="pf-row end">
              <button className="btn-primary sm" disabled={busy || !hookUrl.trim() || hookEvents.length === 0} onClick={() => void createHook()}>Add webhook</button>
            </div>
          </div>
        </div>
      </div>

      {hook && (
        <div className="report-card pf-stack">
          <div className="pf-row between">
            <span className="card-title" style={{ margin: 0 }}>Deliveries · {hook.url}</span>
            <div className="pf-row">
              <span className="pf-faint pf-mono">secret {hook.secretPreview}</span>
              <button className="btn-ghost sm" disabled={busy} onClick={() => void run(async () => { const d = await platformApi.testWebhook(hook.id); setOpenDelivery(d); await loadDeliveries(hook.id); })}>Send test</button>
              <button className="btn-ghost sm" disabled={busy} onClick={() => void run(async () => void (await platformApi.updateWebhook(hook.id, { isActive: !hook.isActive })))}>{hook.isActive ? "Pause" : "Resume"}</button>
              <button className="btn-ghost sm" disabled={busy} onClick={() => void run(async () => { const r = await platformApi.rotateWebhookSecret(hook.id); setRevealed({ label: "New signing secret; the old one stopped working.", value: r.secret }); })}>Rotate secret</button>
              <button
                className={`text-btn danger ${confirmDelete === hook.id ? "armed" : ""}`}
                disabled={busy}
                onClick={() => (confirmDelete === hook.id ? void run(async () => { await platformApi.deleteWebhook(hook.id); setOpenHook(null); setConfirmDelete(null); }) : setConfirmDelete(hook.id))}
              >
                {confirmDelete === hook.id ? "Confirm delete" : "Delete"}
              </button>
            </div>
          </div>
          <div className="pf-grid wide-left">
            <div className="pf-scroll">
              <table className="pf-table">
                <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Tries</th><th>Result</th></tr></thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id} className="clickable" onClick={() => setOpenDelivery(d)}>
                      <td className="pf-mono">{when(d.createdAt)}</td>
                      <td className="pf-mono">{d.eventType}</td>
                      <td><span className={`status-pill ${d.status === "SUCCEEDED" ? "good" : d.status === "FAILED" ? "bad" : "info"}`}>{d.status.toLowerCase()}</span></td>
                      <td>{d.attempts}</td>
                      <td className="pf-faint">{d.lastStatusCode ?? ""} {d.lastError ?? (d.durationMs != null ? `${d.durationMs} ms` : "")}</td>
                    </tr>
                  ))}
                  {deliveries.length === 0 && <tr><td colSpan={5} className="empty">No deliveries yet. Send a test to check your endpoint.</td></tr>}
                </tbody>
              </table>
              {deliveryCursor && <div className="pf-row" style={{ padding: 10 }}><button className="btn-ghost sm" onClick={() => void loadDeliveries(hook.id, deliveryCursor)}>Load more</button></div>}
            </div>
            <div className="pf-stack">
              {!openDelivery && <p className="hint">Select a delivery to see its payload.</p>}
              {openDelivery && (
                <>
                  <dl className="pf-kv">
                    <dt>Event id</dt><dd className="pf-mono">{openDelivery.eventId}</dd>
                    <dt>Status</dt><dd>{openDelivery.status} after {openDelivery.attempts} attempt{openDelivery.attempts === 1 ? "" : "s"}</dd>
                    {openDelivery.nextAttemptAt && <><dt>Next retry</dt><dd>{when(openDelivery.nextAttemptAt)}</dd></>}
                    {openDelivery.lastError && <><dt>Last error</dt><dd>{openDelivery.lastError}</dd></>}
                  </dl>
                  <pre className="pf-json">{JSON.stringify(openDelivery.payload, null, 2)}</pre>
                  {openDelivery.status !== "SUCCEEDED" && (
                    <div className="pf-row"><button className="btn-ghost sm" disabled={busy} onClick={() => void run(async () => { setOpenDelivery(await platformApi.redeliver(openDelivery.id)); await loadDeliveries(hook.id); })}>Redeliver now</button></div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
