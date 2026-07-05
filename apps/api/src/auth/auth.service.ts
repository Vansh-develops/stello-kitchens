import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import type { AuthUser, LoginResponse } from "@petpooja/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true, userOutlets: true },
    });
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const authUser = this.toAuthUser(user);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
    });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "LOGIN", entity: "user", entityId: user.id },
    });
    return { accessToken, user: authUser };
  }

  async resolveUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true, userOutlets: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();
    return this.toAuthUser(user);
  }

  private toAuthUser(user: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    role: { name: string; permissions: unknown };
    userOutlets: { outletId: string }[];
  }): AuthUser {
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      roleName: user.role.name,
      permissions: Array.isArray(user.role.permissions) ? (user.role.permissions as string[]) : [],
      outletIds: user.userOutlets.map((uo) => uo.outletId),
    };
  }
}
