import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  IssueGiftCardSchema,
  VoidGiftCardSchema,
  type AuthUser,
  type IssueGiftCardInput,
  type VoidGiftCardInput,
} from "@stello/shared";
import { GiftCardsService } from "./gift-cards.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller()
export class GiftCardsController {
  constructor(private readonly svc: GiftCardsService) {}

  // Selling a card at the counter.
  @RequirePermission("giftcards.issue")
  @Post("outlets/:outletId/gift-cards")
  issue(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(IssueGiftCardSchema)) body: IssueGiftCardInput,
  ) {
    return this.svc.issue(user, outletId, body);
  }

  // Balance check at settlement. Throttled so codes cannot be brute-forced.
  @RequirePermission("orders.settle")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get("outlets/:outletId/gift-cards/balance")
  balance(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("code") code: string) {
    return this.svc.balance(user, outletId, code);
  }

  @RequirePermission("giftcards.manage")
  @Get("gift-cards")
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user, q);
  }

  @RequirePermission("giftcards.manage")
  @Get("gift-cards/:id")
  detail(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.detail(user, id);
  }

  @RequirePermission("giftcards.manage")
  @Post("gift-cards/:id/void")
  void(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(VoidGiftCardSchema)) body: VoidGiftCardInput,
  ) {
    return this.svc.void(user, id, body.reason);
  }
}
