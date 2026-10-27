import { Body, Controller, Headers, Param, Post, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { PushService } from "./outbound/push.service";

/**
 * Outbound aggregator sync, called by the main API (x-connector-key). Menu,
 * item/stock and store availability and order-status callbacks go to
 * UrbanPiper when URBANPIPER_* credentials are set (otherwise they are logged
 * and reported as simulated); ONDC payloads are built and returned; direct
 * Zomato/Swiggy are partner-gated (501).
 */
@Controller("push")
export class PushController {
  constructor(private readonly push: PushService) {}

  private authorize(key?: string) {
    const expected = process.env.CONNECTOR_KEY;
    const ok = !!expected && !!key && key.length === expected.length && timingSafeEqual(Buffer.from(key), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException("Connector authentication required");
  }

  @Post(":platform/menu")
  menu(@Headers("x-connector-key") key: string | undefined, @Param("platform") platform: string, @Body() body: { outletId: string }) {
    this.authorize(key);
    return this.push.menu(platform.toUpperCase(), body.outletId);
  }

  @Post(":platform/stock")
  stock(
    @Headers("x-connector-key") key: string | undefined,
    @Param("platform") platform: string,
    @Body() body: { outletId: string; items?: { externalId: string; available: boolean }[] },
  ) {
    this.authorize(key);
    return this.push.stock(platform.toUpperCase(), body.outletId, body.items);
  }

  @Post(":platform/store")
  store(
    @Headers("x-connector-key") key: string | undefined,
    @Param("platform") platform: string,
    @Body() body: { outletId: string; online: boolean; reason?: string },
  ) {
    this.authorize(key);
    return this.push.store(platform.toUpperCase(), body.outletId, !!body.online, body.reason);
  }

  @Post(":platform/order-status")
  orderStatus(
    @Headers("x-connector-key") key: string | undefined,
    @Param("platform") platform: string,
    @Body() body: { externalOrderId: string; status: string; prepTimeMins?: number },
  ) {
    this.authorize(key);
    return this.push.orderStatus(platform.toUpperCase(), body.externalOrderId, body.status, body.prepTimeMins);
  }
}
