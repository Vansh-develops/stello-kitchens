"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FloorViewDto, TableShape, WaiterSectionDto } from "@stello/shared";
import { FLOOR_LIMITS, floorLayoutIssues } from "@stello/shared";
import { api } from "@/lib/api";
import { fohApi } from "@/lib/foh-api";
import { TableShapeView } from "./LiveFloor";
import "./foh.css";

type EditTable = {
  key: string;
  tableId?: string;
  name: string;
  seats: number;
  shape: TableShape;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  placed: boolean;
};

const SNAP = 10;
const snap = (n: number) => Math.round(n / SNAP) * SNAP;
const DEFAULTS: Record<TableShape, { width: number; height: number; seats: number }> = {
  ROUND: { width: 90, height: 90, seats: 4 },
  SQUARE: { width: 90, height: 90, seats: 4 },
  RECT: { width: 160, height: 90, seats: 6 },
};

/** Console tab: draw each area's floor (drag/drop, shape, size, rotation, seats) + waiter sections. */
export function FloorPlanEditor({ outletId }: { outletId: string }) {
  const [view, setView] = useState<FloorViewDto | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [tables, setTables] = useState<EditTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newArea, setNewArea] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; startX: number; startY: number; ox: number; oy: number } | null>(null);

  const load = useCallback(
    async (keepArea?: string | null) => {
      const v = await fohApi.floor(outletId);
      setView(v);
      const area = v.areas.find((a) => a.id === (keepArea ?? areaId)) ?? v.areas[0];
      if (area) select(area.id, v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outletId],
  );

  useEffect(() => {
    load(null).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to load floor" }));
  }, [load]);

  function select(id: string, v: FloorViewDto | null = view) {
    const area = v?.areas.find((a) => a.id === id);
    if (!area) return;
    setAreaId(id);
    setSize({ width: area.width, height: area.height });
    setTables(
      area.tables.map((t, i) => ({
        key: t.id,
        tableId: t.id,
        name: t.name,
        seats: t.seats,
        shape: t.placement?.shape ?? "SQUARE",
        x: t.placement?.x ?? 20 + (i % 8) * 110,
        y: t.placement?.y ?? 20 + Math.floor(i / 8) * 110,
        width: t.placement?.width ?? 90,
        height: t.placement?.height ?? 90,
        rotation: t.placement?.rotation ?? 0,
        placed: !!t.placement,
      })),
    );
    setSelected(null);
    setDirty(false);
    setMsg(null);
  }

  const placed = tables.filter((t) => t.placed);
  const issues = useMemo(() => floorLayoutIssues({ ...size, tables: placed }), [size, placed]);
  const badKeys = new Set(issues.map((i) => placed[i.path[1] as number]?.key).filter(Boolean));
  const sel = tables.find((t) => t.key === selected) ?? null;

  const patch = (key: string, p: Partial<EditTable>) => {
    setTables((prev) => prev.map((t) => (t.key === key ? { ...t, ...p } : t)));
    setDirty(true);
  };

  /** First grid spot where a table of this footprint fits without overlapping. */
  const freeSpot = (w: number, h: number) => {
    for (let y = 20; y + h <= size.height; y += 20) {
      for (let x = 20; x + w <= size.width; x += 20) {
        const clash = placed.some((t) => x < t.x + t.width + 10 && t.x < x + w + 10 && y < t.y + t.height + 10 && t.y < y + h + 10);
        if (!clash) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  };

  const addTable = (shape: TableShape) => {
    const d = DEFAULTS[shape];
    const names = new Set(tables.map((t) => t.name.toLowerCase()));
    const prefix = (view?.areas.find((a) => a.id === areaId)?.name[0] ?? "T").toUpperCase();
    let n = tables.length + 1;
    while (names.has(`${prefix}${n}`.toLowerCase())) n++;
    const key = `new-${Date.now()}`;
    setTables((prev) => [...prev, { key, name: `${prefix}${n}`, shape, rotation: 0, placed: true, ...d, ...freeSpot(d.width, d.height) }]);
    setSelected(key);
    setDirty(true);
  };

  const onPointerDown = (t: EditTable) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { key: t.key, startX: e.clientX, startY: e.clientY, ox: t.x, oy: t.y };
    setSelected(t.key);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const scale = size.width / rect.width;
    const t = tables.find((x) => x.key === d.key);
    if (!t) return;
    const x = Math.min(Math.max(0, snap(d.ox + (e.clientX - d.startX) * scale)), size.width - t.width);
    const y = Math.min(Math.max(0, snap(d.oy + (e.clientY - d.startY) * scale)), size.height - t.height);
    if (x !== t.x || y !== t.y) patch(d.key, { x, y });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // Arrow keys nudge the selected table (keyboard-accessible editing).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sel || !sel.placed) return;
    const step = e.shiftKey ? 50 : SNAP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    patch(sel.key, {
      x: Math.min(Math.max(0, sel.x + m[0]), size.width - sel.width),
      y: Math.min(Math.max(0, sel.y + m[1]), size.height - sel.height),
    });
  };

  const save = async () => {
    if (!areaId) return;
    setSaving(true);
    setMsg(null);
    try {
      const v = await fohApi.savePlan(outletId, areaId, {
        ...size,
        tables: placed.map(({ tableId, name, seats, shape, x, y, width, height, rotation }) => ({
          tableId,
          name: name.trim(),
          seats,
          shape,
          x,
          y,
          width,
          height,
          rotation,
        })),
      });
      setView(v);
      select(areaId, v);
      setMsg({ ok: true, text: "Floor plan saved" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const createArea = async () => {
    if (!newArea.trim()) return;
    try {
      const a = await api.createArea(outletId, { name: newArea.trim() });
      setNewArea("");
      await load(a.id);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not create area" });
    }
  };

  if (!view) return <div className="foh-pane">{msg?.text ?? "Loading floor…"}</div>;

  return (
    <div className="foh-pane">
      <div className="foh-row between">
        <h1>Floor plan</h1>
        <div className="foh-row">
          <input placeholder="New area (e.g. Patio)" value={newArea} onChange={(e) => setNewArea(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createArea()} />
          <button className="foh-btn" onClick={createArea} disabled={!newArea.trim()}>
            + Area
          </button>
        </div>
      </div>
      <div className="foh-row">
        {view.areas.map((a) => (
          <button
            key={a.id}
            className={`foh-chip ${a.id === areaId ? "active" : ""}`}
            onClick={() => {
              if (dirty && !confirm("Discard unsaved changes to this area?")) return;
              select(a.id);
            }}
          >
            {a.name} · {a.tables.length}
          </button>
        ))}
        {view.areas.length === 0 && <span className="foh-muted">Create an area to start drawing tables.</span>}
      </div>

      {areaId && (
        <div className="fpe">
          <div className="foh-form">
            <div className="fpe-tools">
              <span className="foh-muted">Add table:</span>
              <button className="foh-btn" onClick={() => addTable("ROUND")}>◯ Round</button>
              <button className="foh-btn" onClick={() => addTable("SQUARE")}>▢ Square</button>
              <button className="foh-btn" onClick={() => addTable("RECT")}>▭ Rectangle</button>
              <span className="grow" />
              <span className="foh-muted">Drag to move · arrows nudge · Shift+arrows move faster</span>
            </div>
            <div
              ref={canvasRef}
              className="fp-canvas"
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              tabIndex={0}
              onClick={(e) => e.target === e.currentTarget && setSelected(null)}
            >
              {placed.map((t) => (
                <TableShapeView
                  key={t.key}
                  table={{ name: t.name, seats: t.seats, placement: t }}
                  area={size}
                  selected={t.key === selected}
                  onPointerDown={onPointerDown(t)}
                  style={{ zIndex: t.key === selected ? 2 : 1 }}
                >
                  {badKeys.has(t.key) && <span className="fp-calls">!</span>}
                </TableShapeView>
              ))}
            </div>
            {issues.length > 0 && (
              <ul className="fpe-issues">
                {issues.slice(0, 6).map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            )}
            <div className="foh-row between">
              <div className="foh-row">
                <label className="field short">
                  <span>Floor width</span>
                  <input type="number" min={FLOOR_LIMITS.minCanvas} max={FLOOR_LIMITS.maxCanvas} step={50} value={size.width} onChange={(e) => { setSize((s) => ({ ...s, width: Number(e.target.value) })); setDirty(true); }} />
                </label>
                <label className="field short">
                  <span>Floor depth</span>
                  <input type="number" min={FLOOR_LIMITS.minCanvas} max={FLOOR_LIMITS.maxCanvas} step={50} value={size.height} onChange={(e) => { setSize((s) => ({ ...s, height: Number(e.target.value) })); setDirty(true); }} />
                </label>
              </div>
              <div className="foh-row">
                {msg && <span className={msg.ok ? "form-success" : "form-error"}>{msg.text}</span>}
                <button className="btn-primary" onClick={save} disabled={saving || issues.length > 0 || !dirty}>
                  {saving ? "Saving…" : "Save floor plan"}
                </button>
              </div>
            </div>
          </div>

          <aside className="fpe-side">
            <div className="foh-card foh-form">
              {sel ? (
                <>
                  <div className="foh-row between">
                    <strong>Table {sel.name}</strong>
                    {sel.placed && (
                      <button className="foh-btn danger" onClick={() => { patch(sel.key, { placed: false }); setSelected(null); }}>
                        Remove from plan
                      </button>
                    )}
                  </div>
                  <div className="fpe-grid2">
                    <label className="field">
                      <span>Name</span>
                      <input value={sel.name} maxLength={20} onChange={(e) => patch(sel.key, { name: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Seats</span>
                      <input type="number" min={1} max={FLOOR_LIMITS.maxSeats} value={sel.seats} onChange={(e) => patch(sel.key, { seats: Math.max(1, Number(e.target.value)) })} />
                    </label>
                  </div>
                  <div className="fpe-shapes">
                    {(["ROUND", "SQUARE", "RECT"] as TableShape[]).map((s) => (
                      <button
                        key={s}
                        className={`foh-chip ${sel.shape === s ? "active" : ""}`}
                        onClick={() => patch(sel.key, s === "ROUND" ? { shape: s, height: sel.width } : { shape: s })}
                      >
                        {s === "ROUND" ? "Round" : s === "SQUARE" ? "Square" : "Rect"}
                      </button>
                    ))}
                  </div>
                  <div className="fpe-grid2">
                    <label className="field">
                      <span>Width</span>
                      <input type="number" min={FLOOR_LIMITS.minTable} max={FLOOR_LIMITS.maxTable} step={10} value={sel.width} onChange={(e) => { const w = Number(e.target.value); patch(sel.key, sel.shape === "ROUND" ? { width: w, height: w } : { width: w }); }} />
                    </label>
                    <label className="field">
                      <span>Depth</span>
                      <input type="number" min={FLOOR_LIMITS.minTable} max={FLOOR_LIMITS.maxTable} step={10} value={sel.height} disabled={sel.shape === "ROUND"} onChange={(e) => patch(sel.key, { height: Number(e.target.value) })} />
                    </label>
                  </div>
                  <label className="field">
                    <span>Rotation {sel.rotation}°</span>
                    <input type="range" min={0} max={345} step={15} value={sel.rotation} onChange={(e) => patch(sel.key, { rotation: Number(e.target.value) })} />
                  </label>
                  {!sel.placed && (
                    <button className="foh-btn primary" onClick={() => patch(sel.key, { placed: true, ...freeSpot(sel.width, sel.height) })}>
                      Place on plan
                    </button>
                  )}
                </>
              ) : (
                <span className="foh-muted">Select a table to edit its name, seats, shape, size and rotation.</span>
              )}
            </div>

            {tables.some((t) => !t.placed) && (
              <div className="foh-card foh-form">
                <strong>Not on the plan</strong>
                <div className="fpe-checks">
                  {tables.filter((t) => !t.placed).map((t) => (
                    <button key={t.key} className="foh-btn" onClick={() => { patch(t.key, { placed: true, ...freeSpot(t.width, t.height) }); setSelected(t.key); }}>
                      + {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <WaiterSections outletId={outletId} view={view} areaId={areaId} />
          </aside>
        </div>
      )}
    </div>
  );
}

/** Assign staff to whole areas or single tables (their "section"). */
function WaiterSections({ outletId, view, areaId }: { outletId: string; view: FloorViewDto; areaId: string }) {
  const [rows, setRows] = useState<WaiterSectionDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fohApi.waiters(outletId).then(setRows).catch((e) => setError(e instanceof Error ? e.message : "Failed to load staff"));
  }, [outletId]);

  const area = view.areas.find((a) => a.id === areaId);
  const toggle = async (row: WaiterSectionDto, kind: "areaIds" | "tableIds", id: string) => {
    const next = { ...row, [kind]: row[kind].includes(id) ? row[kind].filter((x) => x !== id) : [...row[kind], id] };
    try {
      setRows(await fohApi.assignWaiter(outletId, { userId: row.userId, areaIds: next.areaIds, tableIds: next.tableIds }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save section");
    }
  };

  return (
    <div className="foh-card fpe-waiters">
      <strong>Waiter sections</strong>
      {error && <span className="form-error">{error}</span>}
      {rows.length === 0 && <span className="foh-muted">No floor staff yet — invite someone with the Waiter role.</span>}
      {rows.map((r) => (
        <div key={r.userId} className="fpe-waiter">
          <span>
            {r.name} <small className="foh-muted">{r.roleName}</small>
          </span>
          <div className="fpe-checks">
            {view.areas.map((a) => (
              <label key={a.id}>
                <input type="checkbox" checked={r.areaIds.includes(a.id)} onChange={() => toggle(r, "areaIds", a.id)} /> {a.name}
              </label>
            ))}
          </div>
          {area && !r.areaIds.includes(area.id) && area.tables.length > 0 && (
            <div className="fpe-checks">
              {area.tables.map((t) => (
                <label key={t.id}>
                  <input type="checkbox" checked={r.tableIds.includes(t.id)} onChange={() => toggle(r, "tableIds", t.id)} /> {t.name}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
