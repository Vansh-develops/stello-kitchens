import { Body, Controller, Logger, Param, Post } from "@nestjs/common";
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

  @Post(":platform/menu")
  async menu(@Param("platform") platform: string, @Body() body: { outletId: string }) {
    const rows = await this.mainApi.menuPush(platform.toUpperCase(), body.outletId);
    // Triggering a full menu upsert toggles the outlet off provider search until
    // processing completes; only the entities sent are retained (full snapshot).
    this.logger.log(`[${platform}] menu snapshot: ${rows.length} items → (simulated send to provider)`);
    return { platform: platform.toUpperCase(), pushed: rows.length, snapshot: rows };
  }

  @Post(":platform/stock")
  async stock(@Param("platform") platform: string, @Body() body: { outletId: string }) {
    const oos = await this.mainApi.stockPush(platform.toUpperCase(), body.outletId);
    this.logger.log(`[${platform}] stock sync: ${oos.length} item(s) marked out of stock → (simulated)`);
    return { platform: platform.toUpperCase(), outOfStock: oos };
  }
}
