import { Controller, Get, Module, Param, Post } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { LowStockService } from "./low-stock.service";

@RequirePermission("inventory.manage")
@Controller("outlets/:outletId/low-stock")
export class LowStockController {
  constructor(private readonly svc: LowStockService) {}

  @Get("alerts")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @Post("alerts/:id/ack")
  ack(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.acknowledge(user, outletId, id);
  }

  @Post("check")
  check(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.checkNow(user, outletId);
  }
}

@Module({
  controllers: [LowStockController],
  providers: [LowStockService],
})
export class LowStockModule {}
