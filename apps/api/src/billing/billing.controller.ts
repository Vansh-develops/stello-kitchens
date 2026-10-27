import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import {
  BillingSettingsSchema,
  MergeOrdersSchema,
  ParkCartSchema,
  RemoveServiceChargeSchema,
  SettlePreviewSchema,
  SplitOrderSchema,
  TransferOrderSchema,
  type AuthUser,
  type BillingSettingsInput,
  type MergeOrdersInput,
  type ParkCartInput,
  type RemoveServiceChargeInput,
  type SettlePreviewInput,
  type SplitOrderInput,
  type TransferOrderInput,
} from "@stello/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { OrdersService } from "../orders/orders.service";
import { BillingSettingsService } from "./billing-settings.service";
import { OrderOpsService } from "./order-ops.service";
import { ParkedService } from "./parked.service";

@Controller()
export class BillingController {
  constructor(
    private readonly settings: BillingSettingsService,
    private readonly ops: OrderOpsService,
    private readonly parked: ParkedService,
    private readonly orders: OrdersService,
  ) {}

  // ---------- Outlet billing rules ----------

  // POS terminals read these (service charge, round-off, time zone for menus).
  @RequirePermission("orders.create")
  @Get("outlets/:outletId/billing-settings")
  getSettings(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.settings.get(user, outletId);
  }

  @RequirePermission("settings.manage")
  @Put("outlets/:outletId/billing-settings")
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(BillingSettingsSchema)) body: BillingSettingsInput,
  ) {
    return this.settings.update(user, outletId, body);
  }

  // ---------- Settlement preview + service charge ----------

  @RequirePermission("orders.settle")
  @Post("orders/:id/preview")
  preview(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SettlePreviewSchema)) body: SettlePreviewInput,
  ) {
    return this.orders.preview(user, id, body);
  }

  @RequirePermission("orders.service_charge.remove")
  @Post("orders/:id/service-charge/remove")
  removeServiceCharge(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RemoveServiceChargeSchema)) body: RemoveServiceChargeInput,
  ) {
    return this.ops.setServiceCharge(user, id, true, body.reason);
  }

  @RequirePermission("orders.service_charge.remove")
  @Post("orders/:id/service-charge/restore")
  restoreServiceCharge(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.ops.setServiceCharge(user, id, false);
  }

  // ---------- Merge / transfer / split ----------

  @RequirePermission("orders.transfer")
  @Post("orders/:id/merge")
  merge(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MergeOrdersSchema)) body: MergeOrdersInput,
  ) {
    return this.ops.merge(user, id, body);
  }

  @RequirePermission("orders.transfer")
  @Post("orders/:id/transfer")
  transfer(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(TransferOrderSchema)) body: TransferOrderInput,
  ) {
    return this.ops.transfer(user, id, body);
  }

  @RequirePermission("orders.split")
  @Post("orders/:id/split")
  split(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SplitOrderSchema)) body: SplitOrderInput,
  ) {
    return this.ops.split(user, id, body);
  }

  @RequirePermission("orders.split")
  @Post("orders/:id/unsplit")
  unsplit(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.ops.unsplit(user, id);
  }

  // ---------- Parked (held) carts ----------

  @RequirePermission("orders.park")
  @Get("outlets/:outletId/parked")
  listParked(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.parked.list(user, outletId);
  }

  @RequirePermission("orders.park")
  @Post("outlets/:outletId/parked")
  park(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ParkCartSchema)) body: ParkCartInput,
  ) {
    return this.parked.park(user, outletId, body);
  }

  @RequirePermission("orders.park")
  @Post("parked/:id/resume")
  resume(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.parked.resume(user, id);
  }

  @RequirePermission("orders.park")
  @Delete("parked/:id")
  discard(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.parked.discard(user, id);
  }
}
