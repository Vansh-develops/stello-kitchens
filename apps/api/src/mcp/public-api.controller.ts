import { BadRequestException, Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { CurrentUser } from "../common/decorators";
import { ApiKeyAccess } from "../common/api-key-access";
import { PublicApiService } from "./public-api.service";

/**
 * Public REST API for integrations (docs/PUBLIC-API.md). Accepts tenant API
 * keys as well as user sessions; each handler checks its own permission in
 * PublicApiService, so a key only reaches what its scopes allow.
 */
@ApiKeyAccess()
@Controller("ext")
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  @Get("outlets")
  outlets(@CurrentUser() p: AuthUser) {
    return this.api.outlets(p);
  }

  @Get("orders")
  orders(
    @CurrentUser() p: AuthUser,
    @Query("outletId") outletId?: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.api.listOrders(p, { outletId, status, from, to, limit: limit ? Number(limit) : undefined, cursor });
  }

  @Get("orders/:id")
  order(@CurrentUser() p: AuthUser, @Param("id") id: string) {
    return this.api.getOrder(p, id);
  }

  @Get("reports/sales-summary")
  sales(@CurrentUser() p: AuthUser, @Query("outletId") outletId?: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.api.salesSummary(p, outletId, from, to);
  }

  @Get("reports/top-items")
  top(
    @CurrentUser() p: AuthUser,
    @Query("outletId") outletId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    return this.api.topItems(p, outletId, from, to, limit ? Number(limit) : 10);
  }

  @Get("items")
  items(@CurrentUser() p: AuthUser, @Query("outletId") outletId?: string, @Query("search") search?: string) {
    return this.api.items(p, outletId, search);
  }

  @Patch("items/:id/availability")
  availability(
    @CurrentUser() p: AuthUser,
    @Param("id") id: string,
    @Body() body: { inStock?: unknown; outletId?: string },
  ) {
    if (typeof body?.inStock !== "boolean") throw new BadRequestException("inStock (boolean) is required");
    return this.api.setAvailability(p, body.outletId, id, body.inStock);
  }

  @Get("stock")
  stock(@CurrentUser() p: AuthUser, @Query("outletId") outletId?: string, @Query("lowOnly") lowOnly?: string) {
    return this.api.stock(p, outletId, lowOnly === "true");
  }
}
