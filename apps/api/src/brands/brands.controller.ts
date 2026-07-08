import { Body, Controller, Param, Patch } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { UpdateBrandThemeSchema } from "@stello/shared";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { BrandsService } from "./brands.service";

@Controller("brands/:id")
export class BrandsController {
  constructor(private brands: BrandsService) {}

  @Patch("theme")
  @RequirePermission("settings.manage")
  setTheme(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { themeId } = UpdateBrandThemeSchema.parse(body);
    return this.brands.setTheme(user, id, themeId);
  }
}
