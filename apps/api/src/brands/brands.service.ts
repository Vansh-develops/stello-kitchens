import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { isThemeId } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  async setTheme(user: AuthUser, brandId: string, themeId: string) {
    if (!isThemeId(themeId)) throw new ForbiddenException("Unknown theme");
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId } });
    if (!brand || brand.tenantId !== user.tenantId) throw new NotFoundException("Brand not found");
    const updated = await this.prisma.brand.update({
      where: { id: brandId },
      data: { themeId },
    });
    return { id: updated.id, themeId: updated.themeId };
  }
}
