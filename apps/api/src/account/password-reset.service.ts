import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const RESET_TTL_MS = 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Returns the raw token for TESTS only; the controller ignores the return and emails instead. */
  async requestReset(email: string): Promise<string | null> {
    const user = await runUnscoped(() => this.prisma.user.findUnique({ where: { email }, select: { id: true } }));
    if (!user) return null;
    const { raw, hash } = newToken();
    await runUnscoped(() => this.prisma.authToken.create({
      data: { type: "PASSWORD_RESET", userId: user.id, email, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    }));
    await this.email.sendPasswordReset(email, `${APP_URL()}/reset-password?token=${raw}`);
    return raw;
  }

  async reset(rawToken: string, newPassword: string): Promise<void> {
    const hash = hashToken(rawToken);
    const tok = await runUnscoped(() => this.prisma.authToken.findFirst({
      where: { tokenHash: hash, type: "PASSWORD_RESET", usedAt: null, expiresAt: { gt: new Date() } },
    }));
    if (!tok || !tok.userId) throw new BadRequestException("Invalid or expired reset link");
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await runUnscoped(() => this.prisma.$transaction([
      this.prisma.user.update({ where: { id: tok.userId! }, data: { passwordHash } }),
      this.prisma.authToken.update({ where: { id: tok.id }, data: { usedAt: new Date() } }),
    ]));
  }
}
