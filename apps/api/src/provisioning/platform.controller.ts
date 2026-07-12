import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ProvisionTenantSchema, type ProvisionTenantInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ProvisioningService } from "./provisioning.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { PlatformAdminGuard } from "../common/platform-admin.guard";
import { runUnscoped } from "../common/tenant-context";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("tenants")
  create(@Body(new ZodValidationPipe(ProvisionTenantSchema)) body: ProvisionTenantInput) {
    return this.provisioning.provisionTenant({ ...body, createdVia: "ADMIN" });
  }

  @Get("tenants")
  list() {
    return runUnscoped(() =>
      this.prisma.tenant.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true, name: true, status: true, createdVia: true, createdAt: true, onboardedAt: true,
          _count: { select: { users: true, brands: true } },
        },
      }),
    );
  }
}
