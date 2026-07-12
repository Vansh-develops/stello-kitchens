import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { AuthUser, CreateInviteInput, AcceptInviteInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async roles(user: AuthUser) {
    const roles = await this.prisma.role.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return roles;
  }

  async create(user: AuthUser, input: CreateInviteInput): Promise<{ inviteLink: string; raw: string }> {
    const role = await this.prisma.role.findFirst({ where: { id: input.roleId, tenantId: user.tenantId }, select: { id: true } });
    if (!role) throw new NotFoundException("Role not found");
    const existing = await this.prisma.user.findFirst({ where: { tenantId: user.tenantId, email: input.email }, select: { id: true } });
    if (existing) throw new ConflictException("That email is already a user in this restaurant");
    const brand = await this.prisma.brand.findFirst({ where: { tenantId: user.tenantId }, select: { name: true } });
    const { raw, hash } = newToken();
    await this.prisma.authToken.create({
      data: { type: "INVITE", tenantId: user.tenantId, roleId: role.id, email: input.email, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    const link = `${APP_URL()}/invite/accept?token=${raw}`;
    await this.email.sendInvite(input.email, link, brand?.name ?? "the team");
    return { inviteLink: link, raw };
  }

  async accept(rawToken: string, input: AcceptInviteInput): Promise<{ user: { id: string; email: string; tenantId: string } }> {
    const hash = hashToken(rawToken);
    const tok = await runUnscoped(() => this.prisma.authToken.findFirst({
      where: { tokenHash: hash, type: "INVITE", usedAt: null, expiresAt: { gt: new Date() } },
    }));
    if (!tok || !tok.tenantId || !tok.roleId || !tok.email) throw new BadRequestException("Invalid or expired invite");
    const passwordHash = await bcrypt.hash(input.password, 10);
    const outlets = await runUnscoped(() => this.prisma.outlet.findMany({ where: { tenantId: tok.tenantId! }, select: { id: true } }));
    const user = await runUnscoped(() => this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId: tok.tenantId!, email: tok.email!, passwordHash, name: input.name, roleId: tok.roleId!, emailVerified: true,
          userOutlets: { create: outlets.map((o) => ({ outletId: o.id })) },
        },
      });
      await tx.authToken.update({ where: { id: tok.id }, data: { usedAt: new Date() } });
      return u;
    }));
    return { user: { id: user.id, email: user.email, tenantId: user.tenantId } };
  }
}
