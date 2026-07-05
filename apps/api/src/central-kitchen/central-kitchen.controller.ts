import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  CreateIndentSchema,
  GenerateEwayBillSchema,
  type AuthUser,
  type CreateIndentInput,
  type GenerateEwayBillInput,
} from "@petpooja/shared";
import { CentralKitchenService } from "./central-kitchen.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("inventory.manage")
@Controller("outlets/:outletId/central-kitchen")
export class CentralKitchenController {
  constructor(private readonly svc: CentralKitchenService) {}

  @Get("context")
  context(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.context(user, outletId);
  }

  @Get("indents")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @Post("indents")
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateIndentSchema)) body: CreateIndentInput,
  ) {
    return this.svc.createIndent(user, outletId, body);
  }

  @Post("indents/:id/dispatch")
  dispatch(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.dispatch(user, id);
  }

  @Post("indents/:id/receive")
  receive(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.receive(user, id);
  }

  @Post("indents/:id/eway-bill")
  ewayBill(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(GenerateEwayBillSchema)) body: GenerateEwayBillInput,
  ) {
    return this.svc.generateEwayBill(user, id, body.distanceKm);
  }
}
