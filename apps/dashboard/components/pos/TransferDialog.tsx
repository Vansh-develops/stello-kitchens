"use client";

import { useMemo, useState } from "react";
import type { AreaDto, OrderDto } from "@stello/shared";
import { posApi as api } from "@/lib/pos-api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;
type Mode = "table" | "items" | "merge";

/** Move a running bill (or some of its items) to another table, or merge bills. */
export function TransferDialog({
  order,
  areas,
  openOrders,
  onClose,
  onDone,
}: {
  order: OrderDto;
  areas: AreaDto[];
  openOrders: OrderDto[];
  onClose: () => void;
  onDone: (focus: OrderDto) => void;
}) {
  const [mode, setMode] = useState<Mode>(order.tableId ? "table" : "merge");
  const [toTableId, setToTableId] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = order.items.filter((i) => !i.isComboComponent);
  const selectedLines = lines.filter((l) => (qty[l.id] ?? 0) > 0);
  const mergeable = useMemo(
    () => openOrders.filter((o) => o.id !== order.id && !o.parentOrderId && !o.splitCount),
    [openOrders, order.id],
  );
  const occupiedBy = (tableId: string) => openOrders.find((o) => o.tableId === tableId && o.id !== order.id);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "merge") {
        onDone(await api.merge(order.id, { sourceOrderIds: mergeIds }));
      } else if (toTableId) {
        const res = await api.transfer(order.id, {
          toTableId,
          lines: mode === "items" ? selectedLines.map((l) => ({ orderItemId: l.id, quantity: qty[l.id] })) : undefined,
        });
        onDone(res.from ?? res.to);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move the bill");
      setBusy(false);
    }
  };

  const ready =
    mode === "merge" ? mergeIds.length > 0 : !!toTableId && (mode === "table" || selectedLines.length > 0);
  const target = toTableId ? occupiedBy(toTableId) : undefined;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal ops-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Move / merge</h2>
            <span className="settle-sub">
              {order.tableName ?? order.orderType.replace("_", " ")} · {rupee(order.total)}
            </span>
          </div>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="seg">
            <button className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>
              Move bill
            </button>
            <button className={mode === "items" ? "on" : ""} onClick={() => setMode("items")}>
              Move items
            </button>
            <button className={mode === "merge" ? "on" : ""} onClick={() => setMode("merge")}>
              Merge bills
            </button>
          </div>

          {mode === "items" && (
            <div className="ops-lines">
              <span className="opt-label">Items to move</span>
              {lines.map((l) => (
                <div key={l.id} className="ops-line">
                  <span className="ops-line-name">
                    {l.itemName}
                    {l.variationName && <em> · {l.variationName}</em>}
                    <small>
                      {l.quantity} on bill{l.kotNumber != null ? ` · KOT ${l.kotNumber}` : ""}
                    </small>
                  </span>
                  <span className="bl-stepper">
                    <button onClick={() => setQty((q) => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) - 1) }))}>–</button>
                    <span>{qty[l.id] ?? 0}</span>
                    <button onClick={() => setQty((q) => ({ ...q, [l.id]: Math.min(l.quantity, (q[l.id] ?? 0) + 1) }))}>+</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {(mode === "table" || mode === "items") && (
            <div className="table-picker">
              <span className="opt-label">To table</span>
              {areas.map((area) => (
                <div key={area.id} className="tp-area">
                  <span className="tp-area-name">{area.name}</span>
                  <div className="tp-tables">
                    {area.tables
                      .filter((t) => t.id !== order.tableId)
                      .map((t) => (
                        <button
                          key={t.id}
                          className={`tp-table ${occupiedBy(t.id) ? "busy" : ""} ${toTableId === t.id ? "picked" : ""}`}
                          onClick={() => setToTableId(t.id)}
                          title={occupiedBy(t.id) ? "Running bill — items join it" : "Free"}
                        >
                          {t.name}
                        </button>
                      ))}
                  </div>
                </div>
              ))}
              {target && (
                <p className="co-msg ok">
                  {mode === "table" ? "The whole bill merges into" : "Items join"} the running bill on {target.tableName}.
                </p>
              )}
            </div>
          )}

          {mode === "merge" && (
            <div className="ops-lines">
              <span className="opt-label">Fold these bills into this one</span>
              {mergeable.length === 0 && <p className="co-msg">No other running bills.</p>}
              {mergeable.map((o) => (
                <label key={o.id} className="ops-line ops-check">
                  <input
                    type="checkbox"
                    checked={mergeIds.includes(o.id)}
                    onChange={(e) =>
                      setMergeIds((ids) => (e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id)))
                    }
                  />
                  <span className="ops-line-name">
                    {o.tableName ?? o.orderType.replace("_", " ").toLowerCase()}
                    <small>
                      {o.items.filter((i) => !i.isComboComponent).length} items · {o.kots.length} KOT(s)
                    </small>
                  </span>
                  <span className="ops-amt">{rupee(o.total)}</span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button className="btn-primary grow" onClick={submit} disabled={busy || !ready}>
            {busy ? "Working…" : mode === "merge" ? `Merge ${mergeIds.length || ""} bill(s)` : "Move"}
          </button>
        </footer>
      </div>
    </div>
  );
}
