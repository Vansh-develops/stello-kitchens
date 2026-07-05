import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  ComboStockSchema,
  CreateComboSchema,
  UpdateComboSchema,
  type AuthUser,
  type CreateComboInput,
  type UpdateComboInput,
} from "@petpooja/shared";
import { CombosService } from "./combos.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId/combos")
export class CombosController {
  constructor(private readonly svc: CombosService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @RequirePermission("menu.manage")
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateComboSchema)) body: CreateComboInput,
  ) {
    return this.svc.create(user, outletId, body);
  }

  @RequirePermission("menu.manage")
  @Patch(":id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateComboSchema)) body: UpdateComboInput,
  ) {
    return this.svc.update(user, id, body);
  }

  @RequirePermission("menu.manage")
  @Delete(":id")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.remove(user, id);
  }

  // Kitchen/cashier can 86 a combo without full menu edit rights.
  @RequirePermission("menu.stock")
  @Patch(":id/stock")
  toggleStock(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ComboStockSchema)) body: { inStock: boolean },
  ) {
    return this.svc.toggleStock(user, id, body.inStock);
  }
}
