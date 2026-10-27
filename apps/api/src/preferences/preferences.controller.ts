import { Body, Controller, Get, Put } from "@nestjs/common";
import { UpdatePreferencesSchema, type AuthUser, type PreferencesDto, type UpdatePreferencesInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";

// The signed-in user's own settings (UI language). Any authenticated user may
// read/write their own row, so no permission gate beyond the session.
@Controller("me/preferences")
export class PreferencesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<PreferencesDto> {
    const row = await this.prisma.user.findFirst({ where: { id: user.id, tenantId: user.tenantId }, select: { locale: true } });
    return { locale: row?.locale ?? null };
  }

  @Put()
  async set(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdatePreferencesSchema)) body: UpdatePreferencesInput,
  ): Promise<PreferencesDto> {
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { locale: body.locale } });
    return { locale: updated.locale };
  }
}
