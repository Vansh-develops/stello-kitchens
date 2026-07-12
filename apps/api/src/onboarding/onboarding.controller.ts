import { Body, Controller, ForbiddenException, NotFoundException, Param, Post } from "@nestjs/common";
import { CreateAreaSchema, CreateTablesSchema, type AuthUser, type CreateAreaInput, type CreateTablesInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";
import { publicToken } from "../common/public-token";

@Controller("outlets/:outletId")
export class OnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  @RequirePermission("settings.manage")
  @Post("areas")
  async createArea(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateAreaSchema)) body: CreateAreaInput,
  ) {
    this.assertOutlet(user, outletId);
    const owned = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId }, select: { id: true } });
    if (!owned) throw new NotFoundException("Outlet not found");
    const area = await this.prisma.area.create({ data: { tenantId: user.tenantId, outletId, name: body.name } });
    return { id: area.id, name: area.name };
  }

  @RequirePermission("settings.manage")
  @Post("tables")
  async createTables(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateTablesSchema)) body: CreateTablesInput,
  ) {
    this.assertOutlet(user, outletId);
    // The area must belong to the same tenant + outlet.
    const area = await this.prisma.area.findFirst({
      where: { id: body.areaId, tenantId: user.tenantId, outletId },
      select: { id: true },
    });
    if (!area) throw new NotFoundException("Area not found");
    const tables = await this.prisma.$transaction(
      Array.from({ length: body.count }, (_, i) =>
        this.prisma.diningTable.create({
          data: { tenantId: user.tenantId, outletId, areaId: area.id, name: `Table ${i + 1}`, publicToken: publicToken() },
          select: { id: true, name: true, publicToken: true },
        }),
      ),
    );
    return { tables };
  }
}
