import { Body, Controller, Get, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  LoginSchema,
  type LoginInput,
  type AuthUser,
  ForgotPasswordSchema,
  type ForgotPasswordInput,
  ResetPasswordSchema,
  type ResetPasswordInput,
} from "@stello/shared";
import { AuthService } from "./auth.service";
import { PasswordResetService } from "../account/password-reset.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public } from "../common/decorators";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
  ) {}

  // Tight limit to blunt credential brute-force: 10 attempts / minute per IP.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @Post("login")
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body.email, body.password);
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @Post("forgot-password")
  async forgot(@Body(new ZodValidationPipe(ForgotPasswordSchema)) body: ForgotPasswordInput) {
    await this.reset.requestReset(body.email); // ignore return; never leak existence
    return { status: "ok" };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @Post("reset-password")
  async resetPassword(@Body(new ZodValidationPipe(ResetPasswordSchema)) body: ResetPasswordInput) {
    await this.reset.reset(body.token, body.newPassword);
    return { status: "ok" };
  }
}
