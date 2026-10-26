import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  isOwnerLevel,
  missingPermissions,
  type AuthUser,
  type RoleDetailDto,
  type RoleInput,
  type StaffDto,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

const perms = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/**
 * Custom roles and role assignment, with two invariants enforced inside a
 * per-tenant lock (SELECT … FOR UPDATE on the tenant row) so concurrent edits
 * can't race past them:
 *  - no escalation: you can only grant, edit, delete or assign roles whose
 *    permissions you already hold, and only re-assign people whose current role
 *    you could have granted;
 *  - never zero owners: at least one active user must keep an owner-level ("*") role.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser): Promise<RoleDetailDto[]> {
    const roles = await this.prisma.role.findMany({
      where: { tenantId: user.tenantId },
      include: { _count: { select: { users: true } } },
      orderBy: { name: "asc" },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: perms(r.permissions),
      userCount: r._count.users,
      isOwnerRole: isOwnerLevel(perms(r.permissions)),
    }));
  }

  async staff(user: AuthUser): Promise<StaffDto[]> {
    const users = await this.prisma.user.findMany({
      where: { tenantId: user.tenantId },
      include: { role: true },
      orderBy: { name: "asc" },
    });
    const mfa = await this.prisma.userMfa.findMany({
      where: { tenantId: user.tenantId, userId: { in: users.map((u) => u.id) }, enabledAt: { not: null } },
      select: { userId: true },
    });
    const withMfa = new Set(mfa.map((m) => m.userId));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roleId: u.roleId,
      roleName: u.role.name,
      isActive: u.isActive,
      mfaEnabled: withMfa.has(u.id),
    }));
  }

  async create(user: AuthUser, input: RoleInput): Promise<RoleDetailDto> {
    this.assertCanGrant(user, input.permissions);
    try {
      const role = await this.prisma.role.create({
        data: { tenantId: user.tenantId, name: input.name, permissions: [...new Set(input.permissions)] },
      });
      await this.audit(user, "ROLE_CREATED", role.id, { name: role.name, permissions: role.permissions });
      return { id: role.id, name: role.name, permissions: perms(role.permissions), userCount: 0, isOwnerRole: isOwnerLevel(perms(role.permissions)) };
    } catch (err) {
      throw this.mapUnique(err);
    }
  }

  async update(user: AuthUser, id: string, input: RoleInput): Promise<RoleDetailDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockTenant(tx, user.tenantId);
        const role = await this.requireRole(tx, user, id);
        // Editing a role is equivalent to granting both its old and new permissions.
        this.assertCanGrant(user, perms(role.permissions));
        this.assertCanGrant(user, input.permissions);
        const next = [...new Set(input.permissions)];
        if (isOwnerLevel(perms(role.permissions)) && !isOwnerLevel(next)) {
          await this.assertOwnersRemain(tx, user.tenantId, { excludeRoleId: role.id });
        }
        const updated = await tx.role.update({ where: { id: role.id }, data: { name: input.name, permissions: next } });
        const userCount = await tx.user.count({ where: { tenantId: user.tenantId, roleId: role.id } });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: "ROLE_UPDATED",
            entity: "role",
            entityId: role.id,
            data: { name: updated.name, before: perms(role.permissions), after: next },
          },
        });
        return { id: updated.id, name: updated.name, permissions: next, userCount, isOwnerRole: isOwnerLevel(next) };
      });
    } catch (err) {
      throw this.mapUnique(err);
    }
  }

  async remove(user: AuthUser, id: string): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, user.tenantId);
      const role = await this.requireRole(tx, user, id);
      this.assertCanGrant(user, perms(role.permissions));
      const assigned = await tx.user.count({ where: { tenantId: user.tenantId, roleId: role.id } });
      if (assigned > 0) throw new ConflictException("Move the staff on this role to another role before deleting it");
      const pendingInvites = await tx.authToken.count({ where: { tenantId: user.tenantId, roleId: role.id, usedAt: null, expiresAt: { gt: new Date() } } });
      if (pendingInvites > 0) throw new ConflictException("This role has pending invites; let them expire or use another role");
      await tx.role.delete({ where: { id: role.id } });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "ROLE_DELETED", entity: "role", entityId: role.id, data: { name: role.name } },
      });
      return { id: role.id };
    });
  }

  async assign(user: AuthUser, staffId: string, roleId: string): Promise<StaffDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, user.tenantId);
      const target = await tx.user.findFirst({ where: { id: staffId, tenantId: user.tenantId }, include: { role: true } });
      if (!target) throw new NotFoundException("Staff member not found");
      const role = await this.requireRole(tx, user, roleId);
      // You may only move people whose current access you could have granted…
      this.assertCanGrant(user, perms(target.role.permissions));
      // …onto a role within your own access.
      this.assertCanGrant(user, perms(role.permissions));
      if (isOwnerLevel(perms(target.role.permissions)) && !isOwnerLevel(perms(role.permissions)) && target.isActive) {
        await this.assertOwnersRemain(tx, user.tenantId, { excludeUserId: target.id });
      }
      await tx.user.update({ where: { id: target.id }, data: { roleId: role.id } });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "STAFF_ROLE_CHANGED",
          entity: "user",
          entityId: target.id,
          data: { from: target.role.name, to: role.name },
        },
      });
    });
    const list = await this.staff(user);
    return list.find((s) => s.id === staffId)!;
  }

  private assertCanGrant(user: AuthUser, requested: string[]) {
    const missing = missingPermissions(user.permissions, requested);
    if (missing.length) {
      throw new ForbiddenException(`You can't grant permissions you don't hold: ${missing.join(", ")}`);
    }
  }

  private async requireRole(tx: Prisma.TransactionClient, user: AuthUser, id: string) {
    const role = await tx.role.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  /** Serialise role/assignment mutations per tenant. */
  private async lockTenant(tx: Prisma.TransactionClient, tenantId: string) {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
  }

  private async assertOwnersRemain(
    tx: Prisma.TransactionClient,
    tenantId: string,
    exclude: { excludeRoleId?: string; excludeUserId?: string },
  ) {
    const users = await tx.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, roleId: true, role: { select: { permissions: true } } },
    });
    const remaining = users.filter(
      (u) => u.id !== exclude.excludeUserId && u.roleId !== exclude.excludeRoleId && isOwnerLevel(perms(u.role.permissions)),
    );
    if (remaining.length === 0) {
      throw new BadRequestException("At least one active owner must remain");
    }
  }

  private audit(user: AuthUser, action: string, entityId: string, data: object) {
    return this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action, entity: "role", entityId, data: data as Prisma.InputJsonValue },
    });
  }

  private mapUnique(err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return new ConflictException("A role with that name already exists");
    }
    return err;
  }
}
