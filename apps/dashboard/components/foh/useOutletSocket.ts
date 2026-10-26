"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ServerCallDto } from "@stello/shared";

export function socketOrigin(): string | undefined {
  if (process.env.NEXT_PUBLIC_SOCKET_ORIGIN) return process.env.NEXT_PUBLIC_SOCKET_ORIGIN;
  if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return undefined;
}

type Handlers = {
  /** Orders/KOTs/floor/reservations moved — refetch. */
  onChange?: () => void;
  /** A server call was raised or changed. */
  onCall?: (call: ServerCallDto) => void;
};

/**
 * Joins the outlet's realtime room and fans out `kds:changed` / `foh:changed`
 * (→ onChange) and `foh:call` (→ onCall). Handlers are read through a ref so
 * callers can pass inline closures without reconnecting.
 */
export function useOutletSocket(outletId: string, handlers: Handlers): boolean {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("stello.token") : null;
    const socket: Socket = io(socketOrigin(), {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      auth: { token },
    });
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join", { outletId });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    const changed = (msg: { outletId: string }) => {
      if (msg?.outletId === outletId) ref.current.onChange?.();
    };
    socket.on("kds:changed", changed);
    socket.on("foh:changed", changed);
    socket.on("foh:call", (msg: { outletId: string; call: ServerCallDto }) => {
      if (msg?.outletId === outletId) ref.current.onCall?.(msg.call);
    });
    return () => {
      socket.close();
    };
  }, [outletId]);

  return connected;
}
