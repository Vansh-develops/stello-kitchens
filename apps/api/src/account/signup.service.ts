import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { SignupInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ProvisioningService } from "../provisioning/provisioning.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class SignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Returns the raw token for TESTS; the controller emails it and responds generically. */
  async start(input: SignupInput): Promise<string> {
    const existingUser = await runUnscoped(() => this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }));
    if (existingUser) throw new ConflictException("An account with this email already exists");
    const existingPending = await runUnscoped(() => this.prisma.pendingSignup.findUnique({ where: { email: input.email }, select: { id: true } }));
    if (existingPending) throw new ConflictException("A signup for this email is already pending verification");
    const { raw, hash } = newToken();
    const passwordHash = await bcrypt.hash(input.password, 10);
    await runUnscoped(() => this.prisma.pendingSignup.create({
      data: { email: input.email, passwordHash, restaurantName: input.restaurantName, ownerName: input.ownerName, tokenHash: hash, expiresAt: new Date(Date.now() + SIGNUP_TTL_MS) },
    }));
    await this.email.sendVerification(input.email, `${APP_URL()}/signup/verify?token=${raw}`);
    return raw;
  }

  async verify(rawToken: string): Promise<{ tenantId: string; ownerId: string; email: string }> {
    const hash = hashToken(rawToken);
    const pending = await runUnscoped(() => this.prisma.pendingSignup.findFirst({ where: { tokenHash: hash, expiresAt: { gt: new Date() } } }));
    if (!pending) throw new BadRequestException("Invalid or expired verification link");
    // Provisioning hashes a password again; pass a throwaway then overwrite with the stored hash,
    // OR extend provisionTenant to accept a pre-hashed password. Here: create via engine, then set the stored hash.
    const res = await this.provisioning.provisionTenant({
      restaurantName: pending.restaurantName, ownerName: pending.ownerName, ownerEmail: pending.email,
      ownerPassword: rawToken, createdVia: "SIGNUP", // placeholder password; overwritten next line
    });
    await runUnscoped(() => this.prisma.$transaction([
      this.prisma.user.update({ where: { id: res.ownerId }, data: { passwordHash: pending.passwordHash } }),
      this.prisma.pendingSignup.delete({ where: { id: pending.id } }),
    ]));
    return { tenantId: res.tenantId, ownerId: res.ownerId, email: pending.email };
  }
}
