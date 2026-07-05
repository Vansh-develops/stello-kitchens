import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AuthUser } from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { NOTIFICATION_PROVIDER, type NotificationProvider } from "../crm/notification.provider";

const OTP_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class LoyaltyOtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDER) private readonly notifications: NotificationProvider,
  ) {}

  /** Generate + "send" a redemption OTP to an existing customer's phone. */
  async requestOtp(user: AuthUser, outletId: string, phone: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    const customer = await this.prisma.customer.findUnique({
      where: { outletId_phone: { outletId, phone } },
    });
    if (!customer) throw new BadRequestException("No loyalty account for this phone");
    if (customer.loyaltyPoints <= 0) throw new BadRequestException("No points to redeem");

    const code = String(randomInt(100000, 1000000)); // 6 digits
    await this.prisma.loyaltyOtp.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        phone,
        code,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    await this.notifications.send(
      "SMS",
      phone,
      `Your Spice Route redemption OTP is ${code}. Valid for 5 minutes.`,
    );
    return { sent: true, points: customer.loyaltyPoints, expiresInSec: OTP_TTL_MS / 1000 };
  }

  /**
   * Verify + consume the latest OTP for a phone, inside the settle transaction so
   * a code can never be reused. Throws (rolling back settle) on any mismatch.
   */
  async verifyAndConsume(tx: Prisma.TransactionClient, outletId: string, phone: string, code?: string) {
    if (!code) throw new BadRequestException("An OTP is required to redeem points");
    const otp = await tx.loyaltyOtp.findFirst({
      where: { outletId, phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) throw new BadRequestException("No valid OTP — request a new one");
    if (otp.code !== code.trim()) throw new BadRequestException("Incorrect OTP");
    await tx.loyaltyOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  }
}
