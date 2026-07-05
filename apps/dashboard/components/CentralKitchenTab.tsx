"use client";

import { useCallback, useEffect, useState } from "react";
import type { CentralKitchenContextDto, IndentDto } from "@petpooja/shared";
import { api } from "@/lib/api";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const statusTone: Record<string, string> = { DRAFT: "info", DISPATCHED: "info", RECEIVED: "good", CANCELLED: "bad" };

export function CentralKitchenTab({ outletId }: { outletId: string }) {
  const [ctx, setCtx] = useState<CentralKitchenContextDto | null>(null);
  const [indents, setIndents] = useState<IndentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<{ rawMaterialId: string; qty: string }[]>([]);
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const [c, i] = await Promise.all([api.ckContext(outletId), api.ckIndents(outletId)]);
      setCtx(c);
      setIndents(i);
      if (c.role === "satellite" && rows.length === 0 && c.centralMaterials[0]) {
        setRows([{ rawMaterialId: c.centralMaterials[0].id, qty: "" }]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const raiseIndent = () =>
    run(async () => {
      const items = rows
        .filter((r) => r.rawMaterialId && Number(r.qty) > 0)
        .map((r) => ({ rawMaterialId: r.rawMaterialId, requestedQty: Number(r.qty) }));
      if (!items.length) throw new Error("Add at least one material with a quantity");
      await api.ckCreateIndent(outletId, { toOutletId: ctx!.centralKitchen!.id, note: note.trim() || undefined, items });
      setRows([{ rawMaterialId: ctx!.centralMaterials[0]?.id ?? "", qty: "" }]);
      setNote("");
    });

  if (!ctx) return <div className="tab-pane"><p className="empty">{error ?? "Loading…"}</p></div>;

  if (ctx.role === "none") {
    return (
      <div className="tab-pane">
        <div className="pane-head"><h1>Central kitchen</h1></div>
        <p className="hint wide">No central kitchen is configured for this brand. Mark an outlet as a commissary to enable indents and stock transfers between outlets.</p>
      </div>
    );
  }

  const isCentral = ctx.role === "central";

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Central kitchen</h1>
        <span className={`status-pill ${isCentral ? "good" : "info"}`}>
          {isCentral ? "This outlet is the commissary" : `Satellite of ${ctx.centralKitchen?.name.replace("Spice Route - ", "")}`}
        </span>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}

      {!isCentral && (
        <div className="report-card">
          <span className="card-title">Raise an indent to {ctx.centralKitchen?.name.replace("Spice Route - ", "")}</span>
          {rows.map((r, i) => (
            <div key={i} className="indent-row">
              <select value={r.rawMaterialId} onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, rawMaterialId: e.target.value } : x)))}>
                {ctx.centralMaterials.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.unit}) · {m.stockQty} in stock</option>
                ))}
              </select>
              <input type="number" placeholder="Qty" value={r.qty} onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))} />
              <button className="del-row" onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))}>✕</button>
            </div>
          ))}
          <div className="indent-actions">
            <button className="add-row" onClick={() => setRows((p) => [...p, { rawMaterialId: ctx.centralMaterials[0]?.id ?? "", qty: "" }])}>+ Add material</button>
            <input className="indent-note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn-primary sm" onClick={raiseIndent}>Raise indent</button>
          </div>
        </div>
      )}

      <div className="pane-head" style={{ marginTop: 8 }}>
        <h1 style={{ fontSize: 18 }}>{isCentral ? "Incoming indents" : "My indents"}</h1>
      </div>
      <div className="indent-list">
        {indents.map((ind) => (
          <div key={ind.id} className="indent-card">
            <div className="ic-head">
              <div>
                <span className="ic-route">
                  {ind.fromOutletName.replace("Spice Route - ", "")} → {ind.toOutletName.replace("Spice Route - ", "")}
                </span>
                <span className="ic-meta">{new Date(ind.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}{ind.note ? ` · ${ind.note}` : ""}</span>
              </div>
              <span className={`status-pill ${statusTone[ind.status]}`}>{ind.status}</span>
            </div>
            <ul className="ic-items">
              {ind.items.map((it) => (
                <li key={it.id}>
                  <span>{it.materialName}</span>
                  <span className="mono">{it.dispatchedQty > 0 ? it.dispatchedQty : it.requestedQty} {it.unit}</span>
                </li>
              ))}
            </ul>
            <div className="ic-foot">
              <span className="ic-value">{money(ind.value)}</span>
              <div className="ic-actions">
                {ind.ewayBill && (
                  <span className="ewb" title={`Valid until ${ind.ewayBill.validUntil?.slice(0, 10)}`}>
                    EWB {ind.ewayBill.ewbNo}
                  </span>
                )}
                {isCentral && ind.direction === "incoming" && ind.status === "DRAFT" && (
                  <button className="btn-primary sm" onClick={() => void run(() => api.ckDispatch(outletId, ind.id))}>Dispatch</button>
                )}
                {isCentral && ind.status === "DISPATCHED" && !ind.ewayBill && (
                  <button className="btn-ghost sm" onClick={() => void run(() => api.ckEwayBill(outletId, ind.id))}>Generate e-way bill</button>
                )}
                {!isCentral && ind.status === "DISPATCHED" && (
                  <button className="btn-primary sm" onClick={() => void run(() => api.ckReceive(outletId, ind.id))}>Receive stock</button>
                )}
              </div>
            </div>
          </div>
        ))}
        {indents.length === 0 && <p className="empty">{isCentral ? "No incoming indents." : "No indents yet — raise one above."}</p>}
      </div>
    </div>
  );
}
