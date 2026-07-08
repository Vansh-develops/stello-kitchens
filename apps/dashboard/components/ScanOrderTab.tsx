"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { OrderRequestDto, TableQrDto } from "@stello/shared";
import { api } from "@/lib/api";

// Where the diner PWA is served. In dev it's the Vite app on :5176; in prod this
// would be the ordering site's own origin.
const ORDER_BASE =
  typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:5176` : "";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function ScanOrderTab({ outletId }: { outletId: string }) {
  const [view, setView] = useState<"queue" | "qr">("queue");
  const [requests, setRequests] = useState<OrderRequestDto[]>([]);
  const [tables, setTables] = useState<TableQrDto[]>([]);
  const [publicToken, setPublicToken] = useState<string | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const reloadQueue = useCallback(async () => {
    try {
      setRequests(await api.scanRequests(outletId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load requests");
    }
  }, [outletId]);

  // Live-ish queue: poll every 3s while the tab is open.
  useEffect(() => {
    void reloadQueue();
    const t = setInterval(reloadQueue, 3000);
    return () => clearInterval(t);
  }, [reloadQueue]);

  // QR targets load once.
  useEffect(() => {
    api.scanTableQrs(outletId).then(setTables).catch(() => {});
    api.scanPublicToken(outletId).then((r) => setPublicToken(r.token)).catch(() => {});
  }, [outletId]);

  const links = useMemo(() => {
    const map: Record<string, string> = {};
    tables.forEach((t) => (map[`t-${t.tableId}`] = `${ORDER_BASE}/t/${t.token}`));
    if (publicToken) {
      map["kiosk"] = `${ORDER_BASE}/kiosk/${publicToken}`;
      map["board"] = `${ORDER_BASE}/board/${publicToken}`;
    }
    return map;
  }, [tables, publicToken]);

  // Render a scannable QR for every link.
  useEffect(() => {
    Object.entries(links).forEach(([key, url]) => {
      QRCode.toDataURL(url, {
        margin: 1,
        width: 220,
        color: { dark: "#14110f", light: "#f4ede2" },
      }).then((d) => setQr((prev) => (prev[key] === d ? prev : { ...prev, [key]: d })));
    });
  }, [links]);

  const decide = async (id: string, action: "accept" | "reject") => {
    try {
      await (action === "accept" ? api.scanAccept(outletId, id) : api.scanReject(outletId, id));
      await reloadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Scan &amp; Order</h1>
        <div className="seg">
          <button className={view === "queue" ? "on" : ""} onClick={() => setView("queue")}>
            Requests{requests.length > 0 && <span className="seg-badge">{requests.length}</span>}
          </button>
          <button className={view === "qr" ? "on" : ""} onClick={() => setView("qr")}>
            QR codes
          </button>
        </div>
      </div>

      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {view === "queue" && (
        <>
          <p className="hint wide">
            Diners scan a table QR, browse the menu, and submit a cart. Confirm each one before it
            fires a KOT — this keeps stray or prank orders out of the kitchen.
          </p>
          <div className="scan-queue">
            {requests.map((r) => (
              <div key={r.id} className="scan-card">
                <div className="sc-head">
                  <span className={`chan-pill ${r.mode === "DINE_IN" ? "dine" : "take"}`}>
                    {r.mode === "DINE_IN" ? `Dine-in · ${r.tableName ?? "—"}` : "Takeaway"}
                  </span>
                  <span className="sc-time">{new Date(r.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="sc-who">
                  {r.customerName ?? "Guest"}
                  {r.customerPhone ? ` · ${r.customerPhone}` : ""}
                </div>
                <ul className="sc-items">
                  {r.items.map((it, i) => (
                    <li key={i}>
                      <span className="sc-q">{it.quantity}×</span>
                      <span>
                        {it.name}
                        {(it.variationName || it.addonNames.length > 0) && (
                          <em className="sc-opts"> {[it.variationName, ...it.addonNames].filter(Boolean).join(", ")}</em>
                        )}
                        {it.note && <em className="sc-note"> “{it.note}”</em>}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="sc-foot">
                  <span className="sc-total">{money(r.total)}</span>
                  <div className="sc-actions">
                    <button className="btn-ghost sm danger" onClick={() => decide(r.id, "reject")}>
                      Reject
                    </button>
                    <button className="btn-primary sm" onClick={() => decide(r.id, "accept")}>
                      Accept &amp; fire KOT
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {requests.length === 0 && <p className="empty">No pending requests. New Scan &amp; Order carts appear here instantly.</p>}
          </div>
        </>
      )}

      {view === "qr" && (
        <>
          <p className="hint wide">
            Print a table&apos;s QR onto the tent card so diners can order from their seat. The kiosk
            and token-display links run in self-service / TV mode.
          </p>
          <div className="qr-grid">
            {publicToken && (
              <>
                <QrCard label="Self-service kiosk" sub="Takeaway ordering" data={qr["kiosk"]} url={links["kiosk"]} accent />
                <QrCard label="Token display" sub="Counter TV screen" data={qr["board"]} url={links["board"]} accent />
              </>
            )}
            {tables.map((t) => (
              <QrCard
                key={t.tableId}
                label={t.tableName}
                sub={t.areaName}
                data={qr[`t-${t.tableId}`]}
                url={links[`t-${t.tableId}`]}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QrCard({
  label,
  sub,
  data,
  url,
  accent,
}: {
  label: string;
  sub: string;
  data?: string;
  url?: string;
  accent?: boolean;
}) {
  return (
    <a className={`qr-card ${accent ? "accent" : ""}`} href={url} target="_blank" rel="noreferrer">
      <div className="qr-img">{data ? <img src={data} alt={label} /> : <span className="qr-skel" />}</div>
      <span className="qr-label">{label}</span>
      <span className="qr-sub">{sub}</span>
    </a>
  );
}
