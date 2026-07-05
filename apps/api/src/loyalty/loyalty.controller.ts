import { Body, Controller, Param, Post } from "@nestjs/common";
import { RequestOtpSchema, type AuthUser, type RequestOtpInput } from "@petpooja/shared";
import { LoyaltyOtpService } from "./loyalty-otp.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

// Requesting a redemption OTP is part of billing — same permission as settling.
@RequirePermission("orders.settle")
@Controller("outlets/:outletId/loyalty")
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyOtpService) {}

  @Post("request-otp")
  requestOtp(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(RequestOtpSchema)) body: RequestOtpInput,
  ) {
    return this.svc.requestOtp(user, outletId, body.phone);
  }
}
