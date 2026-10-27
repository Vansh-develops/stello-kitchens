"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import type { GatewayPaymentDto, PaymentChangedEvent } from "@stello/shared";
import { integrationsApi } from "@/lib/integrations-api";

const rupee = (n: number) => `₹${n.toFixed(2)}`;

/**
 * "Collect via Razorpay QR": creates a single-use dynamic UPI QR for the amount,
 * then waits for the capture — pushed over the realtime socket
 * (`payment:changed`), with a slow poll as a fallback. On capture it hands the
 * paid amount to the settle dialog as a UPI payment.
 */
export function RazorpayCollect({
  outletId,
  orderId,
  amount,
  onPaid,
}: {
  outletId: string;
  orderId: string;
  amount: number;
  onPaid: (amount: number) => void;
}) {
  const [collection, setCollection] = useState<GatewayPaymentDto | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paidRef = useRef(false);

  const apply = (c: GatewayPaymentDto) => {
    setCollection(c);
    if (c.status === "PAID" && !paidRef.current) {
      paidRef.current = true;
      onPaid(c.amount);
    }
  };

  // Realtime capture + poll fallback while a collection is open.
  const openId = collection?.status === "CREATED" ? collection.id : null;
  useEffect(() => {
    if (!openId) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("stello.token") : null;
    const origin =
      process.env.NEXT_PUBLIC_SOCKET_ORIGIN ??
      (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:3001`
        : undefined);
    const socket: Socket = io(origin, { path: "/socket.io", transports: ["websocket", "polling"], auth: { token } });
    socket.on("connect", () => socket.emit("join", { outletId }));
    socket.on("payment:changed", (e: PaymentChangedEvent) => {
      if (e.intentId === openId) void integrationsApi.collection(outletId, openId).then(apply).catch(() => undefined);
    });
    const poll = setInterval(() => void integrationsApi.collection(outletId, openId).then(apply).catch(() => undefined), 5000);
    return () => {
      clearInterval(poll);
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, outletId]);

  const start = async () => {
    setBusy(true);
    setError(null);
    paidRef.current = false;
    try {
      const c = await integrationsApi.collect(outletId, orderId, amount);
      const source = c.upiString;
      setQr(c.imageUrl ? null : source ? await QRCode.toDataURL(source, { margin: 1, width: 180, color: { dark: "#14110f", light: "#f4ede2" } }) : null);
      apply(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the Razorpay QR");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!collection) return;
    try {
      apply(await integrationsApi.cancelCollection(outletId, collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
    }
  };

  const simulate = async () => {
    if (!collection) return;
    try {
      apply(await integrationsApi.simulatePaid(outletId, collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    }
  };

  const status = collection?.status;
  return (
    <div className="upi-qr-row">
      {!collection || (status !== "CREATED" && status !== "PAID") ? (
        <button className="co-apply" type="button" onClick={start} disabled={busy || amount <= 0}>
          {busy ? "Creating QR…" : status ? `Retry Razorpay QR (${status.toLowerCase()})` : `Collect ${rupee(amount)} via Razorpay QR`}
        </button>
      ) : null}
      {collection && status === "CREATED" && (
        <div className="upi-qr">
          <img src={collection.imageUrl ?? qr ?? ""} alt="Razorpay UPI QR" width={140} height={140} />
          <span className="upi-qr-vpa">
            Waiting for {rupee(collection.amount)}…
            <br />
            {collection.live ? "Razorpay confirms automatically" : "Simulator — no real money moves"}
            <br />
            <button className="text-btn" type="button" onClick={cancel}>Cancel QR</button>
            {!collection.live && (
              <button className="text-btn" type="button" onClick={simulate}> · Simulate payment</button>
            )}
          </span>
        </div>
      )}
      {status === "PAID" && (
        <p className="co-msg ok">
          Paid {rupee(collection!.amount)} via Razorpay ({collection!.paymentId}) — added as UPI. Settle to finish.
        </p>
      )}
      {error && <p className="co-msg bad">{error}</p>}
    </div>
  );
}
