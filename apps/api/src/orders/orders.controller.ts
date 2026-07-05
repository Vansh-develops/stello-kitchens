import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  AddItemsSchema,
  CreateOrderSchema,
  SettleOrderSchema,
  type AddItemsInput,
  type AuthUser,
  type CreateOrderInput,
  type SettleOrderInput,
} from "@petpooja/shared";
import { OrdersService } from "./orders.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermission("orders.create")
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrderInput,
  ) {
    return this.orders.create(user, body);
  }

  @Get()
  listOpen(@CurrentUser() user: AuthUser, @Query("outletId") outletId: string) {
    return this.orders.listOpen(user, outletId);
  }

  @Get(":id")
  getOne(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.orders.getOne(user, id);
  }

  @RequirePermission("orders.create")
  @Post(":id/items")
  addItems(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AddItemsSchema)) body: AddItemsInput,
  ) {
    return this.orders.addItems(user, id, body);
  }

  @RequirePermission("orders.settle")
  @Post(":id/settle")
  settle(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SettleOrderSchema)) body: SettleOrderInput,
  ) {
    return this.orders.settle(user, id, body);
  }

  @RequirePermission("orders.cancel")
  @Post(":id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.orders.cancel(user, id);
  }
}
