import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  MESSAGING_PURPOSE_VARS,
  MessagingConfigSchema,
  OptOutSchema,
  TestMessageSchema,
  type AuthUser,
  type MessagingConfigInput,
  type OptOutInput,
  type TestMessageInput,
} from "@stello/shared";
import { MessagingService } from "./messaging.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@Controller("messaging")
export class MessagingController {
  constructor(private readonly svc: MessagingService) {}

  @RequirePermission("integrations.manage")
  @Get("config")
  config(@CurrentUser() user: AuthUser) {
    return this.svc.getConfig(user);
  }

  @RequirePermission("integrations.manage")
  @Put("config")
  save(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(MessagingConfigSchema)) body: MessagingConfigInput) {
    return this.svc.saveConfig(user, body);
  }

  /** Send one sample message through the live path to check templates/credentials. */
  @RequirePermission("integrations.manage")
  @Post("test")
  async test(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(TestMessageSchema)) body: TestMessageInput) {
    const sample: Record<string, string[]> = {
      OTP: ["123456"],
      CAMPAIGN: ["This is a test message from Stello Kitchens."],
      LOW_STOCK: ["Paneer", "1.5 KG", "5 KG", "Test outlet"],
    };
    const vars = sample[body.purpose] ?? MESSAGING_PURPOSE_VARS[body.purpose];
    const row = await this.svc.sendNow({
      tenantId: user.tenantId,
      purpose: body.purpose,
      channel: body.channel,
      to: body.to,
      body: vars.join(" · "),
      vars,
    });
    return { id: row.id, status: row.status, provider: row.provider };
  }

  @RequirePermission("crm.manage")
  @Get("opt-outs")
  optOuts(@CurrentUser() user: AuthUser) {
    return this.svc.listOptOuts(user);
  }

  @RequirePermission("crm.manage")
  @Post("opt-outs")
  async addOptOut(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(OptOutSchema)) body: OptOutInput) {
    const row = await this.svc.optOut(user.tenantId, body, "STAFF");
    return { id: row.id };
  }

  @RequirePermission("crm.manage")
  @Delete("opt-outs/:id")
  removeOptOut(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.removeOptOut(user, id);
  }

  @RequirePermission("crm.manage")
  @Get("outbox")
  outbox(@CurrentUser() user: AuthUser, @Query("campaignId") campaignId?: string) {
    return this.svc.outbox(user, campaignId || undefined);
  }

  @RequirePermission("crm.manage")
  @Get("campaigns/:id/stats")
  stats(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.campaignStats(user, id);
  }
}

/** Provider callbacks. Each is authenticated by its provider's mechanism. */
@Public()
@SkipThrottle()
@Controller("webhooks")
export class MessagingWebhooksController {
  constructor(private readonly svc: MessagingService) {}

  /** Meta's subscription handshake: echo hub.challenge when the verify token matches. */
  @Get("whatsapp")
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === "subscribe" && expected && token && safeEqual(token, expected)) {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.status(403).send("Forbidden");
  }

  @Post("whatsapp")
  @HttpCode(200)
  whatsapp(@Req() req: RawBodyRequest<Request>, @Headers("x-hub-signature-256") signature: string | undefined) {
    return this.svc.handleWhatsAppWebhook(req.rawBody, signature);
  }

  /** MSG91 delivery reports. MSG91 does not sign callbacks, so the URL carries a secret token. */
  @Post("msg91/:token")
  @HttpCode(200)
  msg91(@Param("token") token: string, @Body() body: unknown) {
    const expected = process.env.MSG91_WEBHOOK_TOKEN;
    if (!expected || !safeEqual(token, expected)) throw new ForbiddenException();
    return this.svc.handleMsg91Report(body);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
