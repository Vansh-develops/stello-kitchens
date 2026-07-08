import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { SyncPushSchema, type AuthUser, type SyncPushInput } from "@stello/shared";
import { SyncService } from "./sync.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("sync")
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  @Get("snapshot")
  snapshot(@CurrentUser() user: AuthUser, @Query("outletId") outletId: string) {
    return this.svc.snapshot(user, outletId);
  }

  @RequirePermission("orders.create")
  @Post("push")
  async push(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SyncPushSchema)) body: SyncPushInput,
  ) {
    const results = await this.svc.push(user, body);
    return { results, serverTime: new Date().toISOString() };
  }

  @Get("pull")
  pull(
    @CurrentUser() user: AuthUser,
    @Query("outletId") outletId: string,
    @Query("since") since?: string,
  ) {
    return this.svc.pull(user, outletId, since);
  }
}
