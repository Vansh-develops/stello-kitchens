"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { renderPayload, type PrintJobDto, type PrintPayload, type PrinterDto } from "@stello/shared";
import { printApi } from "../print-api";
import { printViaBrowser } from "./browser";

// "Printing on this device": which printers this browser terminal delivers to,
// and the local edge print agent it can hand ESC/POS work to. Stored per device
// (localStorage), because it describes this machine, not the outlet.

export interface StationConfig {
  /** Local print agent base, e.g. http://127.0.0.1:4010 (empty = none). */
  agentUrl: string;
  agentKey: string;
  /** Printers this terminal prints ALL jobs for (incl. scan/aggregator KOTs). */
  printerIds: string[];
  /** Print the jobs this user's own actions create (punch, settle, reprint). */
  printOwn: boolean;
  /** Step in for LAN jobs no agent has picked up after this many seconds (0 = never). */
  fallbackAfterSec: number;
}

const DEFAULTS: StationConfig = { agentUrl: "", agentKey: "", printerIds: [], printOwn: true, fallbackAfterSec: 20 };
const keyFor = (outletId: string) => `stello.printStation.${outletId}`;

export function loadStationConfig(outletId: string): StationConfig {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(keyFor(outletId)) ?? "{}") as Partial<StationConfig>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveStationConfig(outletId: string, config: StationConfig) {
  try {
    localStorage.setItem(keyFor(outletId), JSON.stringify(config));
    window.dispatchEvent(new CustomEvent("stello:print-station", { detail: outletId }));
  } catch {
    /* private mode: settings last for this page only */
  }
}

/** A stable id for this browser, reported as the job claimant. */
function terminalId(): string {
  try {
    let id = localStorage.getItem("stello.terminalId");
    if (!id) {
      id = `web-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("stello.terminalId", id);
    }
    return id;
  } catch {
    return "web-ephemeral";
  }
}

// ---------- local agent ----------

export async function probeAgent(config: Pick<StationConfig, "agentUrl" | "agentKey">): Promise<{ ok: boolean; message: string }> {
  if (!config.agentUrl) return { ok: false, message: "No agent configured" };
  try {
    const res = await fetch(`${config.agentUrl.replace(/\/$/, "")}/print/health`, {
      headers: { "X-Print-Key": config.agentKey },
      signal: AbortSignal.timeout(2500),
    });
    if (res.status === 401) return { ok: false, message: "Agent rejected the key" };
    if (!res.ok) return { ok: false, message: `Agent answered ${res.status}` };
    const body = (await res.json()) as { agentId?: string };
    return { ok: true, message: `Connected to ${body.agentId ?? "agent"}` };
  } catch {
    return { ok: false, message: "Agent not reachable" };
  }
}

async function sendToAgent(config: StationConfig, printer: PrinterDto, job: { payload: PrintPayload; copies: number; openDrawer: boolean }) {
  const res = await fetch(`${config.agentUrl.replace(/\/$/, "")}/print/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Print-Key": config.agentKey },
    body: JSON.stringify({ printer, job }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Agent error ${res.status}`);
  }
}

/** Print a document in the browser at the printer's paper width. */
export function browserPrint(payload: PrintPayload, paperWidth: 58 | 80, copies = 1) {
  if (payload.kind === "DRAWER") return Promise.resolve();
  return printViaBrowser(renderPayload(payload, { paperWidth }), { copies, title: payload.kind === "BILL" ? "Bill" : "KOT" });
}

/**
 * Deliver one claimed job. BROWSER printers print here; LAN printers go via the
 * local agent, and fall back to the browser dialog if the agent can't reach them.
 */
async function deliver(config: StationConfig, agentOk: boolean, job: PrintJobDto & { printer: PrinterDto | null }) {
  const printer = job.printer;
  if (!printer) throw new Error("Printer was removed");
  if (printer.connection !== "BROWSER" && agentOk) {
    try {
      await sendToAgent(config, printer, job);
      return;
    } catch (err) {
      if (job.kind === "DRAWER") throw err;
      // Fall through to a browser print so the ticket is never lost.
    }
  }
  if (job.kind === "DRAWER") throw new Error("Drawer kicks need the print agent");
  await browserPrint(job.payload, printer.paperWidth, job.copies);
}

// ---------- the station hook ----------

function socketOrigin() {
  return (
    process.env.NEXT_PUBLIC_SOCKET_ORIGIN ??
    (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : undefined)
  );
}

export interface PrintStation {
  config: StationConfig;
  printers: PrinterDto[];
  agentOk: boolean;
  /** Last delivery problem, for a status chip. */
  lastError: string | null;
  /** Claim and print right now (after an action that queued jobs). */
  kick: () => void;
  reloadPrinters: () => Promise<void>;
}

/**
 * Runs this terminal's print loop: listens for `print:queued` on the outlet
 * room (plus a slow poll), claims the jobs it is responsible for, delivers them
 * and reports PRINTED/FAILED. Claims are atomic server-side, so two terminals
 * configured for the same printer never both print a job.
 */
export function usePrintStation(outletId: string, enabled = true): PrintStation {
  const [config, setConfig] = useState<StationConfig>(() => loadStationConfig(outletId));
  const [printers, setPrinters] = useState<PrinterDto[]>([]);
  const [agentOk, setAgentOk] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const state = useRef({ config, printers, agentOk });
  state.current = { config, printers, agentOk };

  const reloadPrinters = useCallback(async () => {
    try {
      setPrinters(await printApi.printers(outletId));
    } catch {
      setPrinters([]);
    }
  }, [outletId]);

  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent).detail === outletId) setConfig(loadStationConfig(outletId));
    };
    window.addEventListener("stello:print-station", onChange);
    setConfig(loadStationConfig(outletId));
    return () => window.removeEventListener("stello:print-station", onChange);
  }, [outletId]);

  useEffect(() => {
    if (enabled) void reloadPrinters();
  }, [enabled, reloadPrinters]);

  // Re-probe the agent when its settings change, then every minute.
  useEffect(() => {
    if (!enabled || !config.agentUrl) {
      setAgentOk(false);
      return;
    }
    let live = true;
    const probe = () => void probeAgent(config).then((r) => live && setAgentOk(r.ok));
    probe();
    const id = setInterval(probe, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled, config]);

  const runOnce = useCallback(async () => {
    const { config: cfg, printers: list, agentOk: agent } = state.current;
    const active = list.filter((p) => p.isActive);
    const servable = active.filter((p) => p.connection === "BROWSER" || agent).map((p) => p.id);
    const agentId = terminalId();
    const batches = await Promise.all([
      cfg.printOwn && servable.length
        ? printApi.claim(outletId, { agentId, printerIds: servable, mine: true, limit: 5 })
        : Promise.resolve([]),
      cfg.printerIds.length
        ? printApi.claim(outletId, { agentId, printerIds: cfg.printerIds.filter((id) => active.some((p) => p.id === id)), limit: 5 })
        : Promise.resolve([]),
      // Nobody has delivered my LAN job (no agent running anywhere)? Print it here.
      cfg.printOwn && cfg.fallbackAfterSec > 0 && !agent
        ? printApi.claim(outletId, { agentId, connections: ["NETWORK", "USB"], mine: true, olderThanSeconds: cfg.fallbackAfterSec, limit: 5 })
        : Promise.resolve([]),
    ]);
    for (const job of batches.flat()) {
      try {
        await deliver(cfg, agent, job);
        await printApi.complete(job.id, { ok: true, agentId });
        setLastError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Print failed";
        setLastError(`${job.printer?.name ?? "Printer"}: ${message}`);
        await printApi.complete(job.id, { ok: false, error: message, agentId }).catch(() => undefined);
      }
    }
    return batches.flat().length;
  }, [outletId]);

  const kick = useCallback(() => {
    if (!enabled) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        do {
          again.current = false;
          // Keep draining while full batches come back.
          while ((await runOnce()) >= 5) {
            /* next batch */
          }
        } while (again.current);
      } catch {
        /* offline: the poll retries */
      } finally {
        busy.current = false;
      }
    })();
  }, [enabled, runOnce]);

  // Realtime nudge + slow poll (also covers the fallback window).
  useEffect(() => {
    if (!enabled || !printers.length) return;
    const socket: Socket = io(socketOrigin(), { path: "/socket.io", transports: ["websocket", "polling"], withCredentials: true });
    socket.on("connect", () => socket.emit("join", { outletId }));
    socket.on("print:queued", (msg: { outletId: string }) => msg.outletId === outletId && kick());
    const poll = setInterval(kick, 10_000);
    kick();
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [enabled, outletId, printers.length, kick]);

  return { config, printers, agentOk, lastError, kick, reloadPrinters };
}
