import { Body, Controller, Param, Patch } from "@nestjs/common";
import type { AuthUser, UpdateBrandThemeInput } from "@stello/shared";
import { UpdateBrandThemeSchema } from "@stello/shared";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";
import { BrandsService } from "./brands.service";

@Controller("brands/:id")
export class BrandsController {
  constructor(private brands: BrandsService) {}

  @Patch("theme")
  @RequirePermission("settings.manage")
  setTheme(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateBrandThemeSchema)) body: UpdateBrandThemeInput,
  ) {
    return this.brands.setTheme(user, id, body.themeId);
  }
}
