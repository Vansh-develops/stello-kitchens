import { Body, Controller, Headers, Logger, Param, Post, UnauthorizedException } from "@nestjs/common";
import { MainApiService } from "./main-api.service";

/**
 * Outbound menu + stock sync. Pulls the push payload from the main API (mapped
 * items, per-channel prices, out-of-stock ids) and would POST it to the provider.
 * The actual provider call is simulated (logged) until onboarding credentials exist.
 */
@Controller("push")
export class PushController {
  private readonly logger = new Logger(PushController.name);

  constructor(private readonly mainApi: MainApiService) {}

  private authorize(key?: string) {
    const expected = process.env.CONNECTOR_KEY;
    if (!expected || !key || key.length !== expected.length || key !== expected) {
      throw new UnauthorizedException("Connector authentication required");
    }
  }

  @Post(":platform/menu")
  async menu(@Headers("x-connector-key") key: string | undefined, @Param("platform") platform: string, @Body() body: { outletId: string }) {
    this.authorize(key);
    const rows = await this.mainApi.menuPush(platform.toUpperCase(), body.outletId);
    // Triggering a full menu upsert toggles the outlet off provider search until
    // processing completes; only the entities sent are retained (full snapshot).
    this.logger.log(`[${platform}] menu snapshot: ${rows.length} items → (simulated send to provider)`);
    return { platform: platform.toUpperCase(), pushed: rows.length, snapshot: rows };
  }

  @Post(":platform/stock")
  async stock(@Headers("x-connector-key") key: string | undefined, @Param("platform") platform: string, @Body() body: { outletId: string }) {
    this.authorize(key);
    const oos = await this.mainApi.stockPush(platform.toUpperCase(), body.outletId);
    this.logger.log(`[${platform}] stock sync: ${oos.length} item(s) marked out of stock → (simulated)`);
    return { platform: platform.toUpperCase(), outOfStock: oos };
  }
}
