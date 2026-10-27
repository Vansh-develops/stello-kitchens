import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import type { AuthUser, GatewayCollectInput, GatewayPaymentDto, PaymentChangedEvent, UnresolvedRefundDto } from "@stello/shared";
import { toPaise } from "@stello/shared";
import { Prisma, type GatewayPayment } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { runUnscoped } from "../common/tenant-context";
import { MockRazorpayGateway, PAYMENT_GATEWAY, type CollectKind, type PaymentGateway } from "../payments/payment.gateway";
import { refundStatusOf } from "../payments/cash.service";
import { startJobLoop } from "../integrations/job-loop";
import { ProviderHttpError } from "../integrations/http";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const QR_TTL_MS = 15 * 60_000; // Razorpay single-use QR: 2 min – 2 h
const LINK_TTL_MS = 30 * 60_000; // payment links must expire at least 15 min out
const RECONCILE_AFTER_MS = 2 * 60_000;

type RzpEntity = Record<string, unknown> & { id?: string; notes?: Record<string, string> | unknown[] };
interface RzpWebhook {
  event?: string;
  payload?: Record<string, { entity?: RzpEntity } | undefined>;
}

/**
 * Gateway collections (dynamic UPI QR / payment link per bill), the Razorpay
 * webhook, and the recovery job that resolves PENDING/UNKNOWN refunds and
 * unpaid collections. All reconciliation is idempotent: webhooks are recorded
 * by event id, and every state change is a conditional update.
 */
@Injectable()
export class GatewayPaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayPaymentsService.name);
  private stopJob: () => void = () => undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  onModuleInit() {
    this.stopJob = startJobLoop("payments-recovery", Number(process.env.PAYMENTS_RECOVERY_INTERVAL_MS ?? 60_000), () => this.recoveryTick());
  }
  onModuleDestroy() {
    this.stopJob();
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Staff: collect ----------

  async createCollect(user: AuthUser, outletId: string, orderId: string, input: GatewayCollectInput): Promise<GatewayPaymentDto> {
    this.assertOutlet(user, outletId);
    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId: user.tenantId, outletId } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "OPEN" && order.status !== "BILLED") throw new BadRequestException("Only open bills can be collected");
    const amount = input.amount ?? N(order.total);
    if (toPaise(amount) <= 0) throw new BadRequestException("Nothing to collect");
    if (toPaise(amount) > toPaise(N(order.total))) throw new BadRequestException("Amount exceeds the bill total");
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const kind: CollectKind = input.kind ?? (process.env.RAZORPAY_COLLECT_KIND === "LINK" ? "LINK" : "QR");
    const expiresAt = new Date(Date.now() + (kind === "QR" ? QR_TTL_MS : LINK_TTL_MS));

    // Persist first: the row id travels to Razorpay (notes / reference_id) so the
    // webhook can always be matched, even if we crash before saving the response.
    const intent = await this.prisma.gatewayPayment.create({
      data: { tenantId: user.tenantId, outletId, orderId, kind, amount, expiresAt, createdById: user.id, provider: this.gateway.name },
    });
    try {
      const billRef = order.billNumber ?? order.id.slice(-6);
      const res = await this.gateway.createCollect({
        kind,
        amount,
        intentId: intent.id,
        orderRef: billRef,
        description: `${outlet.name} bill ${billRef}`,
        expiresAt,
        customerPhone: input.customerPhone ?? order.customerPhone ?? undefined,
        payeeVpa: outlet.upiVpa ?? "merchant@upi",
        payeeName: outlet.name,
      });
      const saved = await this.prisma.gatewayPayment.update({
        where: { id: intent.id },
        data: {
          providerRef: res.providerRef,
          imageUrl: res.imageUrl ?? null,
          shortUrl: res.shortUrl ?? null,
          upiString: res.upiString ?? null,
          expiresAt: res.expiresAt,
        },
      });
      return this.toDto(saved);
    } catch (e) {
      await this.prisma.gatewayPayment.update({ where: { id: intent.id }, data: { status: "FAILED" } });
      this.logger.warn(`collect create failed for ${intent.id}: ${(e as Error).message}`);
      throw new BadGatewayException("Payment gateway did not create the QR — use another payment mode or retry");
    }
  }

  async getCollect(user: AuthUser, outletId: string, id: string): Promise<GatewayPaymentDto> {
    this.assertOutlet(user, outletId);
    const gp = await this.prisma.gatewayPayment.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!gp) throw new NotFoundException("Collection not found");
    // A cheap, user-driven poll fallback for when the realtime socket is down.
    if (gp.status === "CREATED" && gp.providerRef && Date.now() - gp.createdAt.getTime() > 10_000) {
      await this.refreshCollect(gp).catch(() => undefined);
      return this.toDto(await this.prisma.gatewayPayment.findUniqueOrThrow({ where: { id } }));
    }
    return this.toDto(gp);
  }

  async listForOrder(user: AuthUser, outletId: string, orderId: string): Promise<GatewayPaymentDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.gatewayPayment.findMany({
      where: { tenantId: user.tenantId, outletId, orderId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toDto(r));
  }

  async cancelCollect(user: AuthUser, outletId: string, id: string): Promise<GatewayPaymentDto> {
    this.assertOutlet(user, outletId);
    const gp = await this.prisma.gatewayPayment.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!gp) throw new NotFoundException("Collection not found");
    const res = await this.prisma.gatewayPayment.updateMany({ where: { id, status: "CREATED" }, data: { status: "CANCELLED" } });
    if (res.count === 1 && gp.providerRef) {
      // Best effort: if the customer paid in the same instant, the capture webhook
      // still lands and wins (money received is the source of truth).
      await this.gateway
        .cancelCollect(gp.kind as CollectKind, gp.providerRef)
        .catch((e) => this.logger.warn(`cancel ${id}: ${(e as Error).message}`));
    }
    const saved = await this.prisma.gatewayPayment.findUniqueOrThrow({ where: { id } });
    this.emit(saved);
    return this.toDto(saved);
  }

  /** Dev-only: simulate the customer paying a simulated QR. Refused with a live gateway. */
  async simulatePaid(user: AuthUser, outletId: string, id: string): Promise<GatewayPaymentDto> {
    this.assertOutlet(user, outletId);
    if (this.gateway.live || process.env.NODE_ENV === "production") throw new ForbiddenException("Simulation is disabled");
    const gp = await this.prisma.gatewayPayment.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!gp?.providerRef) throw new NotFoundException("Collection not found");
    if (this.gateway instanceof MockRazorpayGateway) this.gateway.markPaid(gp.providerRef, `pay_sim_${gp.id}`);
    await this.markPaid(gp.id, `pay_sim_${gp.id}`, toPaise(N(gp.amount)), "simulator");
    return this.toDto(await this.prisma.gatewayPayment.findUniqueOrThrow({ where: { id } }));
  }

  // ---------- Webhook ----------

  /**
   * Verify (HMAC over the raw body), record (by event id) and apply a Razorpay
   * webhook. Re-delivery of an event id is acknowledged without re-applying it.
   */
  async handleRazorpayWebhook(rawBody: Buffer | undefined, signature: string | undefined, eventIdHeader: string | undefined) {
    if (!rawBody || !this.gateway.verifyWebhook(rawBody, signature)) throw new UnauthorizedException("Invalid webhook signature");
    let body: RzpWebhook;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Malformed webhook body");
    }
    const event = body.event ?? "unknown";
    const entityId = (body.payload?.refund?.entity?.id ?? body.payload?.payment?.entity?.id ?? "") as string;
    const eventId = eventIdHeader || `${event}:${entityId}`;
    return runUnscoped(async () => {
      try {
        await this.prisma.gatewayEvent.create({
          data: { provider: "razorpay", eventId, event, payload: body as unknown as Prisma.InputJsonValue },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: true, duplicate: true };
        throw e;
      }
      const outcome = await this.applyEvent(event, body);
      await this.prisma.gatewayEvent.update({
        where: { provider_eventId: { provider: "razorpay", eventId } },
        data: { outcome: outcome.outcome, tenantId: outcome.tenantId ?? null, processedAt: new Date() },
      });
      return { ok: true, duplicate: false, outcome: outcome.outcome };
    });
  }

  private async applyEvent(event: string, body: RzpWebhook): Promise<{ outcome: string; tenantId?: string }> {
    const notes = (e?: RzpEntity) => (e?.notes && !Array.isArray(e.notes) ? (e.notes as Record<string, string>) : {});
    if (event === "qr_code.credited" || event === "payment_link.paid" || event === "payment.captured") {
      const payment = body.payload?.payment?.entity;
      if (!payment?.id) return { outcome: "ignored:no-payment" };
      if (payment.status && payment.status !== "captured") return { outcome: `ignored:${String(payment.status)}` };
      const qr = body.payload?.qr_code?.entity;
      const link = body.payload?.payment_link?.entity;
      const intentId = notes(qr).intent_id ?? (link?.reference_id as string | undefined) ?? notes(link).intent_id ?? notes(payment).intent_id;
      const providerRef = (qr?.id ?? link?.id) as string | undefined;
      const gp = intentId
        ? await this.prisma.gatewayPayment.findUnique({ where: { id: intentId } })
        : providerRef
          ? await this.prisma.gatewayPayment.findFirst({ where: { providerRef } })
          : null;
      if (!gp) return { outcome: "ignored:unknown-intent" };
      const r = await this.markPaid(gp.id, payment.id, Number(payment.amount ?? 0), `webhook:${event}`);
      return { outcome: r, tenantId: gp.tenantId };
    }
    if (event.startsWith("refund.")) {
      const rf = body.payload?.refund?.entity;
      if (!rf?.id) return { outcome: "ignored:no-refund" };
      const refund = await this.prisma.refund.findFirst({
        where: { OR: [{ gatewayRef: rf.id }, ...(rf.receipt ? [{ id: String(rf.receipt) }] : [])] },
      });
      if (!refund) return { outcome: "ignored:unknown-refund" };
      const status = refundStatusOf(event === "refund.failed" ? "failed" : event === "refund.processed" ? "processed" : String(rf.status ?? "pending"));
      // Never move a terminal state backwards (a late "created" after "processed").
      const res = await this.prisma.refund.updateMany({
        where: { id: refund.id, status: { in: ["PENDING", "UNKNOWN"] } },
        data: { status, gatewayRef: rf.id, reconciledAt: new Date() },
      });
      if (res.count) await this.audit(refund.tenantId, "REFUND_RECONCILED", "refund", refund.id, { status, source: event });
      return { outcome: res.count ? `refund:${status}` : "refund:no-change", tenantId: refund.tenantId };
    }
    return { outcome: "ignored:event" };
  }

  /** Idempotent capture: CREATED / EXPIRED / CANCELLED → PAID exactly once. */
  async markPaid(intentId: string, paymentId: string, amountPaise: number, source: string): Promise<string> {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id: intentId } });
    if (!gp) return "ignored:unknown-intent";
    if (gp.status === "PAID") return gp.paymentId === paymentId ? "paid:duplicate" : "paid:second-payment";
    if (amountPaise && amountPaise !== toPaise(N(gp.amount))) {
      // Fixed-amount QR/links make this impossible in practice; flag it loudly.
      await this.audit(gp.tenantId, "GATEWAY_AMOUNT_MISMATCH", "gateway_payment", gp.id, {
        paymentId,
        amountPaise,
        expected: toPaise(N(gp.amount)),
      });
      return "mismatch";
    }
    const res = await this.prisma.gatewayPayment.updateMany({
      where: { id: intentId, status: { not: "PAID" } },
      data: { status: "PAID", paymentId, paidAt: new Date() },
    });
    if (!res.count) return "paid:duplicate";
    await this.audit(gp.tenantId, "GATEWAY_PAYMENT_CAPTURED", "gateway_payment", gp.id, {
      orderId: gp.orderId,
      paymentId,
      amount: N(gp.amount),
      source,
    });
    this.emit({ ...gp, status: "PAID" });
    return "paid";
  }

  // ---------- Recovery ----------

  /** One pass of the recovery worker. Safe to run concurrently on several replicas. */
  async recoveryTick(now = new Date()): Promise<{ refunds: number; collections: number }> {
    return runUnscoped(async () => {
      let refunds = 0;
      const stale = new Date(now.getTime() - RECONCILE_AFTER_MS);
      const candidates = await this.prisma.refund.findMany({
        where: {
          status: { in: ["PENDING", "UNKNOWN"] },
          mode: { not: "CASH" },
          createdAt: { lt: stale },
          OR: [{ reconciledAt: null }, { reconciledAt: { lt: stale } }],
        },
        take: 50,
      });
      for (const r of candidates) {
        // Claim: only one replica wins this conditional update.
        const claimed = await this.prisma.refund.updateMany({
          where: { id: r.id, status: { in: ["PENDING", "UNKNOWN"] }, OR: [{ reconciledAt: null }, { reconciledAt: { lt: stale } }] },
          data: { reconciledAt: now },
        });
        if (!claimed.count) continue;
        if (await this.reconcileRefund(r.id)) refunds++;
      }

      let collections = 0;
      const open = await this.prisma.gatewayPayment.findMany({
        where: { status: "CREATED", providerRef: { not: null }, createdAt: { lt: new Date(now.getTime() - 60_000) } },
        take: 50,
      });
      for (const gp of open) {
        if (await this.refreshCollect(gp, now).catch(() => false)) collections++;
      }
      return { refunds, collections };
    });
  }

  /** Resolve one refund against the provider. Returns true when its status changed. */
  async reconcileRefund(refundId: string): Promise<boolean> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!r || !["PENDING", "UNKNOWN"].includes(r.status)) return false;
    const gp = r.gatewayPaymentId ? await this.prisma.gatewayPayment.findUnique({ where: { id: r.gatewayPaymentId } }) : null;
    if (this.gateway.live && !gp?.paymentId) return false; // legacy reservation — an operator must resolve it
    try {
      // The persisted refund id is the provider receipt: look it up first and only
      // (re)submit when the provider has provably never seen it.
      let res = await this.gateway.findRefund(gp?.paymentId ?? "", r.id);
      if (!res) {
        const order = await this.prisma.order.findUnique({ where: { id: r.orderId } });
        res = await this.gateway.refund({
          amount: N(r.amount),
          orderRef: order?.billNumber ?? r.orderId,
          reason: r.reason ?? undefined,
          idempotencyKey: r.id,
          paymentId: gp?.paymentId ?? undefined,
        });
      }
      const status = refundStatusOf(res.status);
      const upd = await this.prisma.refund.updateMany({
        where: { id: r.id, status: { in: ["PENDING", "UNKNOWN"] } },
        data: { status, gatewayRef: res.ref, reconciledAt: new Date() },
      });
      if (upd.count && status !== r.status) {
        await this.audit(r.tenantId, "REFUND_RECONCILED", "refund", r.id, { from: r.status, to: status, source: "recovery" });
        return true;
      }
      return false;
    } catch (e) {
      // Still uncertain: keep the reservation; the next tick retries.
      this.logger.warn(`refund ${r.id} reconcile failed: ${(e as Error).message}`);
      if (e instanceof ProviderHttpError && e.uncertain && r.status === "PENDING") {
        await this.prisma.refund.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "UNKNOWN" } });
      }
      return false;
    }
  }

  /** Poll one open collection; expire it at the provider once past its deadline. */
  private async refreshCollect(gp: GatewayPayment, now = new Date()): Promise<boolean> {
    if (!gp.providerRef) return false;
    const st = await this.gateway.fetchCollectStatus(gp.kind as CollectKind, gp.providerRef);
    if (st.status === "PAID" && st.paymentId) {
      return (await this.markPaid(gp.id, st.paymentId, st.amountPaise ?? 0, "recovery")) === "paid";
    }
    const pastDue = !!gp.expiresAt && gp.expiresAt.getTime() + 60_000 < now.getTime();
    if (st.status === "EXPIRED" || st.status === "CANCELLED" || pastDue) {
      if (pastDue && st.status === "PENDING") {
        await this.gateway.cancelCollect(gp.kind as CollectKind, gp.providerRef).catch(() => undefined);
      }
      const next = st.status === "CANCELLED" ? "CANCELLED" : "EXPIRED";
      const res = await this.prisma.gatewayPayment.updateMany({ where: { id: gp.id, status: "CREATED" }, data: { status: next } });
      if (res.count) this.emit({ ...gp, status: next });
      return res.count > 0;
    }
    return false;
  }

  // ---------- Operator reconciliation ----------

  async unresolvedRefunds(user: AuthUser, outletId: string): Promise<UnresolvedRefundDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.refund.findMany({
      where: { tenantId: user.tenantId, outletId, status: { in: ["PENDING", "UNKNOWN", "MANUAL"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      amount: N(r.amount),
      mode: r.mode,
      status: r.status,
      gatewayRef: r.gatewayRef,
      createdAt: r.createdAt.toISOString(),
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
    }));
  }

  async reconcileRefundNow(user: AuthUser, outletId: string, refundId: string) {
    this.assertOutlet(user, outletId);
    const r = await this.prisma.refund.findFirst({ where: { id: refundId, tenantId: user.tenantId, outletId } });
    if (!r) throw new NotFoundException("Refund not found");
    await this.reconcileRefund(r.id);
    const after = await this.prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
    return { id: after.id, status: after.status, gatewayRef: after.gatewayRef };
  }

  // ---------- helpers ----------

  private emit(gp: Pick<GatewayPayment, "id" | "outletId" | "orderId" | "status" | "amount">) {
    const payload: PaymentChangedEvent = {
      outletId: gp.outletId,
      orderId: gp.orderId,
      intentId: gp.id,
      status: gp.status as PaymentChangedEvent["status"],
      amount: N(gp.amount),
    };
    this.realtime.server?.to(`outlet:${gp.outletId}`).emit("payment:changed", payload);
  }

  private async audit(tenantId: string, action: string, entity: string, entityId: string, data: Record<string, unknown>) {
    await this.prisma.auditLog.create({ data: { tenantId, userId: null, action, entity, entityId, data: data as Prisma.InputJsonValue } });
  }

  private toDto(gp: GatewayPayment): GatewayPaymentDto {
    return {
      id: gp.id,
      orderId: gp.orderId,
      kind: gp.kind as GatewayPaymentDto["kind"],
      amount: N(gp.amount),
      status: gp.status as GatewayPaymentDto["status"],
      providerRef: gp.providerRef,
      paymentId: gp.paymentId,
      imageUrl: gp.imageUrl,
      shortUrl: gp.shortUrl,
      upiString: gp.upiString,
      expiresAt: gp.expiresAt?.toISOString() ?? null,
      paidAt: gp.paidAt?.toISOString() ?? null,
      live: this.gateway.live,
    };
  }
}
