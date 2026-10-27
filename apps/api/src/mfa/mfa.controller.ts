import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  MfaCodeSchema,
  PasswordConfirmSchema,
  SecuritySettingsSchema,
  type AuthUser,
  type MfaCodeInput,
  type PasswordConfirmInput,
  type SecuritySettingsInput,
} from "@stello/shared";
import { MfaService } from "./mfa.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

/** Self-service 2FA for the signed-in user. */
@Controller("auth/mfa")
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.mfa.status(user);
  }

  @HttpCode(200)
  @Post("setup")
  setup(@CurrentUser() user: AuthUser) {
    return this.mfa.beginSetup(user);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  @Post("enable")
  enable(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(MfaCodeSchema)) body: MfaCodeInput) {
    return this.mfa.confirmSetup(user, body.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  @Post("disable")
  async disable(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(PasswordConfirmSchema)) body: PasswordConfirmInput) {
    await this.mfa.disable(user, body.password, body.code);
    return { status: "ok" };
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  @Post("recovery-codes")
  regenerate(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(PasswordConfirmSchema)) body: PasswordConfirmInput) {
    return this.mfa.regenerateRecoveryCodes(user, body.password, body.code);
  }
}

/** Tenant-wide security policy. */
@RequirePermission("settings.manage")
@Controller("security/settings")
export class SecuritySettingsController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.mfa.policy(user.tenantId);
  }

  @Put()
  put(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(SecuritySettingsSchema)) body: SecuritySettingsInput) {
    return this.mfa.setPolicy(user, body.requireOwnerMfa);
  }
}
