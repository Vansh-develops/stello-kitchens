import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  WEBHOOK_EVENTS,
  WebhookCreateSchema,
  WebhookUpdateSchema,
  type AuthUser,
  type WebhookCreateInput,
  type WebhookUpdateInput,
} from "@stello/shared";
import { WebhooksService } from "./webhooks.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("integrations.manage")
@Controller("integrations/webhooks")
export class WebhooksController {
  constructor(private readonly hooks: WebhooksService) {}

  @Get("events")
  events() {
    return WEBHOOK_EVENTS;
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.hooks.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(WebhookCreateSchema)) body: WebhookCreateInput) {
    return this.hooks.create(user, body);
  }

  @Patch(":id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(WebhookUpdateSchema)) body: WebhookUpdateInput) {
    return this.hooks.update(user, id, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.hooks.remove(user, id);
  }

  @HttpCode(200)
  @Post(":id/rotate-secret")
  rotate(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.hooks.rotateSecret(user, id);
  }

  @HttpCode(200)
  @Post(":id/test")
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.hooks.testSend(user, id);
  }

  @Get(":id/deliveries")
  deliveries(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("cursor") cursor?: string) {
    return this.hooks.deliveries(user, id, cursor);
  }

  @HttpCode(200)
  @Post("deliveries/:deliveryId/redeliver")
  redeliver(@CurrentUser() user: AuthUser, @Param("deliveryId") deliveryId: string) {
    return this.hooks.redeliver(user, deliveryId);
  }
}
