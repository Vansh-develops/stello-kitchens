import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import type { AuthUser, LoginResponse } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const authUser = await this.authenticate(email, password);
    const { tokenVersion } = await this.prisma.user.findUniqueOrThrow({ where: { id: authUser.id }, select: { tokenVersion: true } });
    const accessToken = await this.jwt.signAsync({
      sub: authUser.id,
      tenantId: authUser.tenantId,
      tokenVersion,
    });
    await this.recordLogin(authUser);
    return { accessToken, user: authUser };
  }

  /** Password step only: returns the user or throws a generic 401. */
  async authenticate(email: string, password: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true, userOutlets: true, tenant: true },
    });
    if (!user || !user.isActive || user.tenant.status === "SUSPENDED" || (user.tenant.status === "TRIAL" && user.tenant.trialEndsAt && user.tenant.trialEndsAt < new Date()) || !(await bcrypt.compare(password, user.passwordHash))) {
      if (user) {
        await this.prisma.auditLog.create({
          data: { tenantId: user.tenantId, userId: user.id, action: "LOGIN_FAILED", entity: "user", entityId: user.id },
        });
      }
      throw new UnauthorizedException("Invalid email or password");
    }
    return this.toAuthUser(user);
  }

  async recordLogin(user: AuthUser): Promise<void> {
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "LOGIN", entity: "user", entityId: user.id },
    });
  }

  async resolveUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true, userOutlets: true, tenant: true },
    });
    if (!user || !user.isActive || user.tenant.status === "SUSPENDED" || (user.tenant.status === "TRIAL" && user.tenant.trialEndsAt && user.tenant.trialEndsAt < new Date())) throw new UnauthorizedException();
    return this.toAuthUser(user);
  }

  async getTokenVersion(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
    if (!user) throw new UnauthorizedException();
    return user.tokenVersion;
  }

  private toAuthUser(user: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    role: { name: string; permissions: unknown };
    userOutlets: { outletId: string }[];
    isPlatformAdmin: boolean;
  }): AuthUser {
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      roleName: user.role.name,
      permissions: Array.isArray(user.role.permissions) ? (user.role.permissions as string[]) : [],
      outletIds: user.userOutlets.map((uo) => uo.outletId),
      isPlatformAdmin: user.isPlatformAdmin,
    };
  }
}
