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
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_GATEWAY, type PaymentGateway } from "./payment.gateway";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

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
    await this.prisma.cashMovement.create({
      data: {
        sessionId: session.id,
        type: input.type,
        amount: signed,
        category: input.type === "EXPENSE" ? (input.category ?? "General") : null,
        note: input.note ?? null,
      },
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
    const order = await this.prisma.order.findFirst({ where: { id: orderId, outletId } });
    if (!order || order.status !== "SETTLED") throw new BadRequestException("Only settled orders can be refunded");
    if (input.amount > N(order.total)) throw new BadRequestException("Refund exceeds the order total");

    let gatewayRef: string | null = null;
    if (input.mode !== "CASH") {
      const res = await this.gateway.refund({ amount: input.amount, orderRef: order.billNumber ?? order.id, reason: input.reason });
      gatewayRef = res.ref;
    }
    const refund = await this.prisma.refund.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        orderId,
        amount: input.amount,
        mode: input.mode,
        reason: input.reason ?? null,
        gatewayRef,
      },
    });
    // A cash refund leaves the drawer if one is open.
    if (input.mode === "CASH") {
      const session = await this.prisma.cashSession.findFirst({ where: { outletId, status: "OPEN" } });
      if (session) {
        await this.prisma.cashMovement.create({
          data: { sessionId: session.id, type: "REFUND", amount: -input.amount, orderId, note: input.reason ?? "Refund" },
        });
      }
    }
    return { id: refund.id, gatewayRef };
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
