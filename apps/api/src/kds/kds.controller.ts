import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AdvanceTicketSchema, type AdvanceTicketInput, type AuthUser } from "@stello/shared";
import { KdsService } from "./kds.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller()
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  @Get("outlets/:outletId/kds/stations")
  stations(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.kds.stations(user, outletId);
  }

  @Get("outlets/:outletId/kds/tickets")
  tickets(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.kds.tickets(user, outletId);
  }

  @Get("outlets/:outletId/kds/stock")
  stock(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.kds.stock(user, outletId);
  }

  @RequirePermission("kds.operate")
  @Post("kds/kots/:kotId/advance")
  advance(
    @CurrentUser() user: AuthUser,
    @Param("kotId") kotId: string,
    @Body(new ZodValidationPipe(AdvanceTicketSchema)) body: AdvanceTicketInput,
  ) {
    return this.kds.advance(user, kotId, body);
  }
}
