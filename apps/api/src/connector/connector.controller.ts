import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  AggregatorStatusUpdateSchema,
  ConnectorIngestSchema,
  type AggregatorStatusUpdateInput,
  type AuthUser,
  type ConnectorIngestInput,
} from "@stello/shared";
import { ConnectorService } from "./connector.service";
import { ConnectorKeyGuard } from "./connector-key.guard";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public } from "../common/decorators";

/** Service-to-service surface used by the connector deployable (key-authenticated). */
@Public()
@UseGuards(ConnectorKeyGuard)
@Controller("connector")
export class ConnectorServiceController {
  constructor(private readonly svc: ConnectorService) {}

  @Post("ingest")
  ingest(@Body(new ZodValidationPipe(ConnectorIngestSchema)) body: ConnectorIngestInput) {
    return this.svc.ingest(body);
  }

  @Post("orders/:platform/:externalOrderId/status")
  updateStatus(
    @Param("platform") platform: string,
    @Param("externalOrderId") externalOrderId: string,
    @Body(new ZodValidationPipe(AggregatorStatusUpdateSchema)) body: AggregatorStatusUpdateInput,
  ) {
    return this.svc.updateStatus(platform.toUpperCase(), externalOrderId, body.status);
  }

  @Get("menu-push/:platform")
  menuPush(@Param("platform") platform: string, @Query("outletId") outletId: string) {
    return this.svc.menuPush(platform.toUpperCase(), outletId);
  }

  @Get("stock/:platform")
  stock(@Param("platform") platform: string, @Query("outletId") outletId: string) {
    return this.svc.stockPush(platform.toUpperCase(), outletId);
  }
}

/** Dashboard-facing reads (JWT-authenticated). */
@Controller("outlets/:outletId/aggregator")
export class ConnectorController {
  constructor(private readonly svc: ConnectorService) {}

  @Get("orders")
  orders(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.listOrders(user, outletId);
  }

  @Get("reconciliation")
  reconciliation(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.reconciliation(user, outletId);
  }
}
