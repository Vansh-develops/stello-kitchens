import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CampaignSchema,
  CouponSchema,
  FeedbackSubmitSchema,
  LoyaltyAdjustSchema,
  type AuthUser,
  type CampaignInput,
  type CouponInput,
  type FeedbackSubmitInput,
  type LoyaltyAdjustInput,
} from "@petpooja/shared";
import { CrmService } from "./crm.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId")
export class CrmController {
  constructor(private readonly svc: CrmService) {}

  // Customers
  @Get("customers")
  customers(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.customers(user, outletId);
  }

  @Get("customers/summary")
  summary(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.summary(user, outletId);
  }

  @Get("customers/by-phone")
  byPhone(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("phone") phone: string,
  ) {
    return this.svc.lookupByPhone(user, outletId, phone ?? "");
  }

  @Get("customers/:id")
  detail(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.customerDetail(user, outletId, id);
  }

  @RequirePermission("crm.manage")
  @Post("customers/:id/loyalty")
  adjust(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(LoyaltyAdjustSchema)) body: LoyaltyAdjustInput,
  ) {
    return this.svc.adjustLoyalty(user, outletId, id, body);
  }

  // Coupons
  @Get("coupons")
  coupons(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.coupons(user, outletId);
  }

  @Get("coupons/preview")
  preview(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("code") code: string,
    @Query("subtotal") subtotal: string,
  ) {
    return this.svc.previewCoupon(user, outletId, code, Number(subtotal) || 0);
  }

  @RequirePermission("crm.manage")
  @Post("coupons")
  createCoupon(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CouponSchema)) body: CouponInput,
  ) {
    return this.svc.createCoupon(user, outletId, body);
  }

  @RequirePermission("crm.manage")
  @Patch("coupons/:id")
  setCouponActive(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.svc.setCouponActive(user, outletId, id, !!body.isActive);
  }

  @RequirePermission("crm.manage")
  @Delete("coupons/:id")
  deleteCoupon(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.deleteCoupon(user, outletId, id);
  }

  // Campaigns
  @Get("campaigns")
  campaigns(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.campaigns(user, outletId);
  }

  @RequirePermission("crm.manage")
  @Post("campaigns")
  createCampaign(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CampaignSchema)) body: CampaignInput,
  ) {
    return this.svc.createCampaign(user, outletId, body);
  }

  @RequirePermission("crm.manage")
  @Post("campaigns/:id/send")
  sendCampaign(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.sendCampaign(user, outletId, id);
  }

  // Feedback
  @Get("feedback")
  feedback(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.feedbackList(user, outletId);
  }
}

/** Public feedback intake — reached from a QR-on-bill / SMS link, no auth. */
@Controller("public/feedback")
export class PublicFeedbackController {
  constructor(private readonly svc: CrmService) {}

  @Public()
  @Post(":outletId")
  submit(
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(FeedbackSubmitSchema)) body: FeedbackSubmitInput,
  ) {
    return this.svc.submitFeedback({ ...body, outletId });
  }
}
