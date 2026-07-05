import { Controller, Get, Param, Post } from "@nestjs/common";
import type { AuthUser } from "@petpooja/shared";
import { HardwareService } from "./hardware.service";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@RequirePermission("orders.create")
@Controller("outlets/:outletId/hardware")
export class HardwareController {
  constructor(private readonly svc: HardwareService) {}

  @Get("scale")
  scale(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.readScale(user, outletId);
  }

  @Get("caller-id")
  callerId(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.callerId(user, outletId);
  }
}

// Diner-facing wireless calling device (page a waiter from the table QR).
@Public()
@Controller("public/scan/t/:token")
export class CallWaiterController {
  constructor(private readonly svc: HardwareService) {}

  @Post("call-waiter")
  callWaiter(@Param("token") token: string) {
    return this.svc.callWaiter(token);
  }
}
