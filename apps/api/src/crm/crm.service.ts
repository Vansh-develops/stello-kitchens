import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  evaluateCoupon,
  type AuthUser,
  type CampaignDto,
  type CampaignInput,
  type CouponDto,
  type CouponInput,
  type CouponPreviewDto,
  type CustomerDetailDto,
  type CustomerDto,
  type CustomerSegment,
  type CustomerSummaryDto,
  type FeedbackDto,
  type FeedbackSubmitInput,
  type LoyaltyAdjustInput,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NOTIFICATION_PROVIDER, type NotificationProvider } from "./notification.provider";

const LAPSED_DAYS = 60;

function segmentOf(c: { totalOrders: number; totalSpent: number; lastVisitAt: Date | null }): CustomerSegment {
  if (c.lastVisitAt && Date.now() - c.lastVisitAt.getTime() > LAPSED_DAYS * 86400_000) return "LAPSED";
  if (c.totalSpent >= 5000 || c.totalOrders >= 10) return "VIP";
  if (c.totalOrders >= 3) return "REGULAR";
  return "NEW";
}

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDER) private readonly notifications: NotificationProvider,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Customers ----------

  async customers(user: AuthUser, outletId: string): Promise<CustomerDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.customer.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { totalSpent: "desc" },
    });
    return rows.map((c) => this.toCustomerDto(c));
  }

  async summary(user: AuthUser, outletId: string): Promise<CustomerSummaryDto> {
    this.assertOutlet(user, outletId);
    const [rows, outlet] = await Promise.all([
      this.prisma.customer.findMany({ where: { tenantId: user.tenantId, outletId } }),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } }),
    ]);
    const segments: Record<CustomerSegment, number> = { NEW: 0, REGULAR: 0, VIP: 0, LAPSED: 0 };
    for (const c of rows) segments[segmentOf({ totalOrders: c.totalOrders, totalSpent: Number(c.totalSpent), lastVisitAt: c.lastVisitAt })] += 1;
    return { total: rows.length, segments, pointValue: Number(outlet.loyaltyPointValue) };
  }

  /** POS billing lookup: current points + point value for a phone (or found=false). */
  async lookupByPhone(user: AuthUser, outletId: string, phone: string) {
    this.assertOutlet(user, outletId);
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
    const c = phone
      ? await this.prisma.customer.findUnique({ where: { outletId_phone: { outletId, phone } } })
      : null;
    return {
      found: !!c,
      id: c?.id ?? null,
      name: c?.name ?? null,
      loyaltyPoints: c?.loyaltyPoints ?? 0,
      pointValue: Number(outlet.loyaltyPointValue),
    };
  }

  async customerDetail(user: AuthUser, outletId: string, id: string): Promise<CustomerDetailDto> {
    this.assertOutlet(user, outletId);
    const customer = await this.prisma.customer.findFirst({
      where: { id, outletId, tenantId: user.tenantId },
      include: {
        transactions: { orderBy: { createdAt: "desc" }, take: 30 },
        orders: { where: { status: "SETTLED" }, orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    return {
      customer: this.toCustomerDto(customer),
      transactions: customer.transactions.map((t) => ({
        id: t.id,
        type: t.type as "EARN" | "REDEEM" | "TOPUP" | "ADJUST",
        points: t.points,
        note: t.note,
        createdAt: t.createdAt.toISOString(),
      })),
      orders: customer.orders.map((o) => ({
        id: o.id,
        billNumber: o.billNumber,
        orderType: o.orderType as CustomerDetailDto["orders"][number]["orderType"],
        total: Number(o.total),
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  async adjustLoyalty(user: AuthUser, outletId: string, id: string, input: LoyaltyAdjustInput) {
    this.assertOutlet(user, outletId);
    const customer = await this.prisma.customer.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!customer) throw new NotFoundException("Customer not found");
    if (customer.loyaltyPoints + input.points < 0) throw new BadRequestException("Adjustment would make balance negative");
    await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data: { loyaltyPoints: { increment: input.points } } }),
      this.prisma.loyaltyTransaction.create({
        data: {
          customerId: id,
          type: input.points > 0 ? "TOPUP" : "ADJUST",
          points: input.points,
          note: input.note ?? null,
        },
      }),
    ]);
    return { id, points: customer.loyaltyPoints + input.points };
  }

  // ---------- Coupons ----------

  async coupons(user: AuthUser, outletId: string): Promise<CouponDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.coupon.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => this.toCouponDto(c));
  }

  async createCoupon(user: AuthUser, outletId: string, input: CouponInput) {
    this.assertOutlet(user, outletId);
    const existing = await this.prisma.coupon.findFirst({ where: { outletId, code: input.code } });
    if (existing) throw new BadRequestException("A coupon with that code already exists");
    const coupon = await this.prisma.coupon.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        code: input.code,
        type: input.type,
        value: input.value,
        minOrder: input.minOrder ?? 0,
        maxDiscount: input.maxDiscount ?? null,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validTo: input.validTo ? new Date(input.validTo) : null,
        usageLimit: input.usageLimit ?? null,
        isActive: input.isActive ?? true,
      },
    });
    return { id: coupon.id };
  }

  async setCouponActive(user: AuthUser, outletId: string, id: string, isActive: boolean) {
    this.assertOutlet(user, outletId);
    const coupon = await this.prisma.coupon.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!coupon) throw new NotFoundException("Coupon not found");
    await this.prisma.coupon.update({ where: { id }, data: { isActive } });
    return { id, isActive };
  }

  async deleteCoupon(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const coupon = await this.prisma.coupon.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!coupon) throw new NotFoundException("Coupon not found");
    await this.prisma.coupon.delete({ where: { id } });
    return { id };
  }

  async previewCoupon(user: AuthUser, outletId: string, code: string, subtotal: number): Promise<CouponPreviewDto> {
    this.assertOutlet(user, outletId);
    const c = await this.prisma.coupon.findFirst({ where: { outletId, code: code.toUpperCase() } });
    return evaluateCoupon(
      c
        ? {
            type: c.type as "PERCENT" | "FLAT",
            value: Number(c.value),
            minOrder: Number(c.minOrder),
            maxDiscount: c.maxDiscount ? Number(c.maxDiscount) : null,
            validFrom: c.validFrom?.toISOString() ?? null,
            validTo: c.validTo?.toISOString() ?? null,
            usageLimit: c.usageLimit,
            usedCount: c.usedCount,
            isActive: c.isActive,
          }
        : null,
      subtotal,
      new Date().toISOString(),
    );
  }

  // ---------- Campaigns ----------

  async campaigns(user: AuthUser, outletId: string): Promise<CampaignDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.campaign.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => this.toCampaignDto(c));
  }

  async createCampaign(user: AuthUser, outletId: string, input: CampaignInput) {
    this.assertOutlet(user, outletId);
    const campaign = await this.prisma.campaign.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        name: input.name,
        channel: input.channel,
        segment: input.segment,
        message: input.message,
      },
    });
    return { id: campaign.id };
  }

  async sendCampaign(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const campaign = await this.prisma.campaign.findFirst({ where: { id, outletId, tenantId: user.tenantId } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (campaign.status === "SENT") throw new BadRequestException("Campaign already sent");

    const customers = await this.prisma.customer.findMany({ where: { tenantId: user.tenantId, outletId } });
    const recipients = customers.filter(
      (c) =>
        campaign.segment === "ALL" ||
        segmentOf({ totalOrders: c.totalOrders, totalSpent: Number(c.totalSpent), lastVisitAt: c.lastVisitAt }) ===
          campaign.segment,
    );
    const channel = campaign.channel as "SMS" | "WHATSAPP" | "EMAIL";
    for (const c of recipients) {
      const to = channel === "EMAIL" ? (c.email ?? c.phone) : c.phone;
      await this.notifications.send(channel, to, campaign.message);
    }
    await this.prisma.campaign.update({
      where: { id },
      data: { status: "SENT", sentCount: recipients.length },
    });
    return { id, sent: recipients.length };
  }

  // ---------- Feedback ----------

  async submitFeedback(input: FeedbackSubmitInput & { outletId: string }): Promise<{ ok: true }> {
    const outlet = await this.prisma.outlet.findUnique({ where: { id: input.outletId } });
    if (!outlet) throw new NotFoundException("Unknown outlet");
    let customerId: string | null = null;
    if (input.phone) {
      const c = await this.prisma.customer.findUnique({
        where: { outletId_phone: { outletId: input.outletId, phone: input.phone } },
      });
      customerId = c?.id ?? null;
    }
    await this.prisma.feedback.create({
      data: {
        tenantId: outlet.tenantId,
        outletId: input.outletId,
        orderId: input.orderId ?? null,
        customerId,
        rating: input.rating,
        comment: input.comment ?? null,
      },
    });
    return { ok: true };
  }

  async feedbackList(user: AuthUser, outletId: string): Promise<FeedbackDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.feedback.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { customer: true },
    });
    return rows.map((f) => ({
      id: f.id,
      rating: f.rating,
      comment: f.comment,
      customerName: f.customer?.name ?? f.customer?.phone ?? null,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  // ---------- mappers ----------

  private toCustomerDto(c: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    loyaltyPoints: number;
    totalOrders: number;
    totalSpent: Prisma.Decimal;
    lastVisitAt: Date | null;
    createdAt: Date;
  }): CustomerDto {
    const totalSpent = Number(c.totalSpent);
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      loyaltyPoints: c.loyaltyPoints,
      totalOrders: c.totalOrders,
      totalSpent,
      lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
      segment: segmentOf({ totalOrders: c.totalOrders, totalSpent, lastVisitAt: c.lastVisitAt }),
      createdAt: c.createdAt.toISOString(),
    };
  }

  private toCouponDto(c: {
    id: string;
    code: string;
    type: string;
    value: Prisma.Decimal;
    minOrder: Prisma.Decimal;
    maxDiscount: Prisma.Decimal | null;
    validFrom: Date | null;
    validTo: Date | null;
    usageLimit: number | null;
    usedCount: number;
    isActive: boolean;
  }): CouponDto {
    return {
      id: c.id,
      code: c.code,
      type: c.type as "PERCENT" | "FLAT",
      value: Number(c.value),
      minOrder: Number(c.minOrder),
      maxDiscount: c.maxDiscount ? Number(c.maxDiscount) : null,
      validFrom: c.validFrom?.toISOString() ?? null,
      validTo: c.validTo?.toISOString() ?? null,
      usageLimit: c.usageLimit,
      usedCount: c.usedCount,
      isActive: c.isActive,
    };
  }

  private toCampaignDto(c: {
    id: string;
    name: string;
    channel: string;
    segment: string;
    message: string;
    sentCount: number;
    status: string;
    createdAt: Date;
  }): CampaignDto {
    return {
      id: c.id,
      name: c.name,
      channel: c.channel as CampaignDto["channel"],
      segment: c.segment as CampaignDto["segment"],
      message: c.message,
      sentCount: c.sentCount,
      status: c.status as CampaignDto["status"],
      createdAt: c.createdAt.toISOString(),
    };
  }
}
