import { Body, Controller, Get, Module, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  AggregatorOrderActionSchema,
  AggregatorPushSchema,
  AggregatorStoreToggleSchema,
  type AggregatorOrderActionInput,
  type AggregatorStoreToggleInput,
  type AuthUser,
} from "@stello/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { ConnectorKeyGuard } from "../connector/connector-key.guard";
import { AggregatorSyncService } from "./aggregator-sync.service";

@Controller("outlets/:outletId/aggregator-sync")
export class AggregatorSyncController {
  constructor(private readonly svc: AggregatorSyncService) {}

  @RequirePermission("integrations.manage")
  @Post("menu")
  menu(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(AggregatorPushSchema)) body: { platform: string }) {
    return this.svc.pushMenu(user, outletId, body.platform);
  }

  @RequirePermission("menu.stock")
  @Post("stock")
  stock(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(AggregatorPushSchema)) body: { platform: string }) {
    return this.svc.pushStock(user, outletId, body.platform);
  }

  @RequirePermission("integrations.manage")
  @Post("store")
  store(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(AggregatorStoreToggleSchema)) body: AggregatorStoreToggleInput,
  ) {
    return this.svc.setStore(user, outletId, body.platform, body.online, body.reason);
  }

  @RequirePermission("orders.settle")
  @Post("orders/:id/status")
  orderStatus(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AggregatorOrderActionSchema)) body: AggregatorOrderActionInput,
  ) {
    return this.svc.orderAction(user, outletId, id, body);
  }

  @RequirePermission("integrations.manage")
  @Get("log")
  log(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.syncLog(user, outletId);
  }
}

/** Connector → API: full catalogue for outbound menu pushes (service key). */
@Public()
@UseGuards(ConnectorKeyGuard)
@Controller("connector/catalog")
export class ConnectorCatalogController {
  constructor(private readonly svc: AggregatorSyncService) {}

  @Get(":platform")
  catalog(@Param("platform") platform: string, @Query("outletId") outletId: string) {
    return this.svc.catalog(platform.toUpperCase(), outletId);
  }
}

@Module({
  controllers: [AggregatorSyncController, ConnectorCatalogController],
  providers: [AggregatorSyncService],
})
export class AggregatorSyncModule {}
