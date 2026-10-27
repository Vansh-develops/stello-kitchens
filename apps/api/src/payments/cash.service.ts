import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  CashMovementDto,
  CashMovementInput,
  CashSessionDto,
  CashSessionReportDto,
  RefundInput,
  UpiQrDto,
} from "@stello/shared";
import { toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_GATEWAY, type PaymentGateway } from "./payment.gateway";
import { issueStoreCreditTx } from "../gift-cards/gift-cards.service";
import { recordDrawerExpenseTx } from "../finance/finance.service";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Provider refund status → our reservation status. Only a verified failure releases balance. */
export const refundStatusOf = (s: string) => (s === "processed" ? "PROCESSED" : s === "failed" ? "FAILED" : "PENDING");

type SessionWithMovements = Prisma.CashSessionGetPayload<{ include: { movements: true } }>;

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async openDrawer(user: AuthUser, outletId: string, openingFloat: number) {
    this.assertOutlet(user, outletId);
    const open = await this.prisma.cashSession.findFirst({ where: { outletId, status: "OPEN" } });
    if (open) throw new BadRequestException("A cash drawer is already open for this outlet");
    const session = await this.prisma.cashSession.create({
      data: { tenantId: user.tenantId, outletId, openedById: user.id, openingFloat },
    });
    return { id: session.id };
  }

  async closeDrawer(user: AuthUser, outletId: string, countedCash: number): Promise<CashSessionReportDto> {
    this.assertOutlet(user, outletId);
    const session = await this.prisma.cashSession.findFirst({
      where: { outletId, status: "OPEN" },
      include: { movements: true },
    });
    if (!session) throw new BadRequestException("No open drawer to close");
    await this.prisma.cashSession.update({
      where: { id: session.id },
      data: { status: "CLOSED", closedAt: new Date(), countedCash },
    });
    return this.report(user, outletId, session.id);
  }

  async current(user: AuthUser, outletId: string): Promise<CashSessionDto | null> {
    this.assertOutlet(user, outletId);
    const session = await this.prisma.cashSession.findFirst({
      where: { outletId, status: "OPEN" },
      include: { movements: true },
    });
    return session ? this.toSessionDto(session) : null;
  }

  async addMovement(user: AuthUser, outletId: string, input: CashMovementInput) {
    this.assertOutlet(user, outletId);
    const session = await this.prisma.cashSession.findFirst({ where: { outletId, status: "OPEN" } });
    if (!session) throw new BadRequestException("Open a cash drawer before recording cash movements");
    // PAY_IN adds cash; PAY_OUT / EXPENSE remove it.
    const signed = input.type === "PAY_IN" ? input.amount : -input.amount;
    await this.prisma.$transaction(async (tx) => {
      const movement = await tx.cashMovement.create({
        data: {
          sessionId: session.id,
          type: input.type,
          amount: signed,
          category: input.type === "EXPENSE" ? (input.category ?? "General") : null,
          note: input.note ?? null,
        },
      });
      // Drawer expenses also land in the expense book (and so the P&L).
      if (input.type === "EXPENSE") {
        await recordDrawerExpenseTx(tx, {
          tenantId: user.tenantId, outletId, userId: user.id, cashMovementId: movement.id,
          category: input.category ?? "General", amount: input.amount, note: input.note ?? null,
        });
      }
    });
    return { ok: true };
  }

  async report(user: AuthUser, outletId: string, sessionId: string): Promise<CashSessionReportDto> {
    this.assertOutlet(user, outletId);
    const session = await this.prisma.cashSession.findFirst({
      where: { id: sessionId, outletId, tenantId: user.tenantId },
      include: { movements: { orderBy: { createdAt: "desc" } } },
    });
    if (!session) throw new NotFoundException("Session not found");

    const byCat = new Map<string, number>();
    for (const m of session.movements) {
      if (m.type === "EXPENSE") byCat.set(m.category ?? "General", (byCat.get(m.category ?? "General") ?? 0) + Math.abs(N(m.amount)));
    }
    return {
      session: this.toSessionDto(session),
      movements: session.movements.map((m) => this.toMovementDto(m)),
      expensesByCategory: [...byCat.entries()]
        .map(([category, amount]) => ({ category, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  async recentSessions(user: AuthUser, outletId: string): Promise<CashSessionDto[]> {
    this.assertOutlet(user, outletId);
    const sessions = await this.prisma.cashSession.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { openedAt: "desc" },
      take: 15,
      include: { movements: true },
    });
    return sessions.map((s) => this.toSessionDto(s));
  }

  // ---------- Payments ----------

  async upiQr(user: AuthUser, outletId: string, orderId: string, amountOverride?: number): Promise<UpiQrDto> {
    this.assertOutlet(user, outletId);
    const order = await this.prisma.order.findFirst({ where: { id: orderId, outletId } });
    if (!order) throw new NotFoundException("Order not found");
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const vpa = outlet.upiVpa ?? "merchant@upi";
    const amount = amountOverride && amountOverride > 0 ? amountOverride : N(order.total) || N(order.subtotal);
    const qr = this.gateway.createUpiQr({
      amount,
      orderRef: order.billNumber ?? order.id.slice(-6),
      payeeVpa: vpa,
      payeeName: outlet.name,
    });
    return { upiString: qr.upiString, amount: round2(amount), ref: qr.ref, payeeVpa: vpa };
  }

  async refund(user: AuthUser, outletId: string, orderId: string, input: RefundInput) {
    this.assertOutlet(user, outletId);
    if (!Number.isFinite(input.amount) || input.amount <= 0 || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 1e-7) {
      throw new BadRequestException("Refund amount must be positive whole paise");
    }
    const reserved = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${orderId} AND "tenantId" = ${user.tenantId}
        AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Order not found");
      const order = await tx.order.findFirstOrThrow({ where: { id: orderId, tenantId: user.tenantId, outletId } });
      if (order.status !== "SETTLED") throw new BadRequestException("Only settled orders can be refunded");
      if (input.requestKey) {
        const existing = await tx.refund.findFirst({ where: { tenantId: user.tenantId, outletId, orderId, requestKey: input.requestKey } });
        if (existing) {
          if (toPaise(N(existing.amount)) !== toPaise(input.amount) || existing.mode !== input.mode || existing.reason !== (input.reason ?? null)) {
            throw new BadRequestException("Refund request key was already used for different details");
          }
          return { refund: existing, isNew: false, orderRef: order.billNumber ?? order.id };
        }
      }
      // Include pending/uncertain operations: a provider timeout is not evidence
      // that money was not refunded. Only verified FAILED operations release funds.
      const previous = await tx.refund.aggregate({
        where: { tenantId: user.tenantId, outletId, orderId, status: { not: "FAILED" } },
        _sum: { amount: true },
      });
      const recordedPayments = await tx.orderPayment.aggregate({ where: { orderId }, _sum: { amount: true } });
      const limit = Math.min(toPaise(N(order.total)), toPaise(N(recordedPayments._sum.amount ?? 0)));
      if (toPaise(N(previous._sum.amount ?? 0)) + toPaise(input.amount) > limit) {
        throw new BadRequestException("Refund exceeds the remaining refundable balance");
      }
      // Electronic refunds draw from a captured gateway payment with enough
      // unrefunded balance (computed under the order lock). With a live gateway and
      // no such payment (card on an EDC machine, static UPI), the money must be
      // returned outside the system: record it as MANUAL, still reserving balance.
      let gatewayPaymentId: string | null = null;
      if (input.mode !== "CASH" && input.mode !== "GIFT_CARD") {
        const captured = await tx.gatewayPayment.findMany({
          where: { tenantId: user.tenantId, outletId, orderId, status: "PAID", paymentId: { not: null } },
          orderBy: { paidAt: "asc" },
        });
        for (const gp of captured) {
          const used = await tx.refund.aggregate({ where: { gatewayPaymentId: gp.id, status: { not: "FAILED" } }, _sum: { amount: true } });
          if (toPaise(N(gp.amount)) - toPaise(N(used._sum.amount ?? 0)) >= toPaise(input.amount)) {
            gatewayPaymentId = gp.id;
            break;
          }
        }
      }
      // Cash and store-credit (GIFT_CARD) refunds complete immediately.
      const status = input.mode === "CASH" || input.mode === "GIFT_CARD" ? "PROCESSED" : this.gateway.live && !gatewayPaymentId ? "MANUAL" : "PENDING";
      let refund = await tx.refund.create({
        data: {
          tenantId: user.tenantId, outletId, orderId, amount: input.amount, mode: input.mode,
          reason: input.reason ?? null, requestKey: input.requestKey ?? null,
          status, gatewayPaymentId,
        },
      });
      // GIFT_CARD refunds are issued as store credit — no money leaves the business.
      if (input.mode === "GIFT_CARD") {
        const code = await issueStoreCreditTx(tx, {
          tenantId: user.tenantId, outletId, amount: input.amount, orderId, userId: user.id,
          note: input.reason ?? `Refund for ${order.billNumber ?? orderId}`,
          customerPhone: order.customerPhone, customerName: order.customerName,
        });
        refund = await tx.refund.update({ where: { id: refund.id }, data: { gatewayRef: code } });
      }
      if (input.mode === "CASH") {
        const session = await tx.cashSession.findFirst({ where: { tenantId: user.tenantId, outletId, status: "OPEN" } });
        if (session) await tx.cashMovement.create({
          data: { sessionId: session.id, type: "REFUND", amount: -input.amount, orderId, note: input.reason ?? "Refund" },
        });
      }
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "REFUND_RESERVED", entity: "refund", entityId: refund.id,
          data: { orderId, amount: input.amount, mode: input.mode, status: refund.status } },
      });
      return { refund, isNew: true, orderRef: order.billNumber ?? order.id };
    });
    let refund = reserved.refund;
    // Never hold database locks across a remote payment call. Retrying the API
    // returns the reservation instead of blindly calling the provider again.
    if (reserved.isNew && refund.status === "PENDING") {
      try {
        const paymentId = refund.gatewayPaymentId
          ? (await this.prisma.gatewayPayment.findUnique({ where: { id: refund.gatewayPaymentId } }))?.paymentId ?? undefined
          : undefined;
        const res = await this.gateway.refund({ amount: input.amount, orderRef: reserved.orderRef, reason: input.reason, idempotencyKey: refund.id, paymentId });
        refund = await this.prisma.refund.update({
          where: { id: refund.id },
          data: { gatewayRef: res.ref, status: refundStatusOf(res.status) },
        });
      } catch {
        // Do not release the reservation: provider success followed by a network
        // failure must be reconciled before another refund can spend this balance.
        refund = await this.prisma.refund.update({ where: { id: refund.id }, data: { status: "UNKNOWN" } });
      }
    }
    return { id: refund.id, gatewayRef: refund.gatewayRef, status: refund.status };
  }

  // ---------- mappers ----------

  private toSessionDto(s: SessionWithMovements): CashSessionDto {
    let cashSales = 0, payIns = 0, payOuts = 0, expenses = 0, refunds = 0;
    for (const m of s.movements) {
      const amt = N(m.amount);
      if (m.type === "SALE") cashSales += amt;
      else if (m.type === "PAY_IN") payIns += amt;
      else if (m.type === "PAY_OUT") payOuts += -amt;
      else if (m.type === "EXPENSE") expenses += -amt;
      else if (m.type === "REFUND") refunds += -amt;
    }
    const opening = N(s.openingFloat);
    const expected = opening + cashSales + payIns - payOuts - expenses - refunds;
    const counted = s.countedCash != null ? N(s.countedCash) : null;
    return {
      id: s.id,
      status: s.status as "OPEN" | "CLOSED",
      openingFloat: round2(opening),
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      countedCash: counted != null ? round2(counted) : null,
      cashSales: round2(cashSales),
      payIns: round2(payIns),
      payOuts: round2(payOuts),
      expenses: round2(expenses),
      refunds: round2(refunds),
      expectedCash: round2(expected),
      variance: counted != null ? round2(counted - expected) : null,
    };
  }

  private toMovementDto(m: { id: string; type: string; amount: Prisma.Decimal; category: string | null; note: string | null; createdAt: Date }): CashMovementDto {
    return {
      id: m.id,
      type: m.type as CashMovementDto["type"],
      amount: N(m.amount),
      category: m.category,
      note: m.note,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
