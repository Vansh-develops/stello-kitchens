import { ConflictException, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";

const TRIAL_DAYS = 14;

const STANDARD_ROLES = [
  { name: "Owner", permissions: ["*"] },
  { name: "Cashier", permissions: ["orders.create", "orders.settle", "menu.stock"] },
  { name: "Kitchen", permissions: ["kds.operate", "menu.stock"] },
];

export interface ProvisionInput {
  restaurantName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  createdVia: "ADMIN" | "SIGNUP";
  themeId?: string;
}

@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provisionTenant(input: ProvisionInput): Promise<{ tenantId: string; ownerId: string }> {
    const passwordHash = await bcrypt.hash(input.ownerPassword, 10);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    return runUnscoped(() =>
      this.prisma.$transaction(async (tx) => {
        // Duplicate-email check runs as the transaction's first statement (not a
        // separate pre-check call) so it shares the same unscoped session as the
        // writes below — see provisioning.service.test.ts for why a standalone
        // runUnscoped() read is not reliable here.
        const existing = await tx.user.findUnique({ where: { email: input.ownerEmail }, select: { id: true } });
        if (existing) throw new ConflictException("An account with this email already exists");

        const tenant = await tx.tenant.create({
          data: { name: input.restaurantName, status: "TRIAL", createdVia: input.createdVia, trialEndsAt },
        });
        const brand = await tx.brand.create({
          data: { tenantId: tenant.id, name: input.restaurantName, themeId: input.themeId ?? "counter" },
        });
        const roles = await Promise.all(
          STANDARD_ROLES.map((r) =>
            tx.role.create({ data: { tenantId: tenant.id, name: r.name, permissions: r.permissions } }),
          ),
        );
        const ownerRole = roles.find((r) => r.name === "Owner")!;
        const outlet = await tx.outlet.create({
          data: { tenantId: tenant.id, brandId: brand.id, name: "Main Outlet" },
        });
        const owner = await tx.user.create({
          data: {
            tenantId: tenant.id, email: input.ownerEmail, passwordHash, name: input.ownerName,
            roleId: ownerRole.id, emailVerified: true,
            userOutlets: { create: [{ outletId: outlet.id }] },
          },
        });
        await tx.auditLog.create({
          data: { tenantId: tenant.id, userId: owner.id, action: "TENANT_CREATED", entity: "tenant", entityId: tenant.id },
        });
        return { tenantId: tenant.id, ownerId: owner.id };
      }),
    );
  }
}
