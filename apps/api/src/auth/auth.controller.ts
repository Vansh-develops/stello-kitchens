import { Body, Controller, Get, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { LoginSchema, type LoginInput, type AuthUser } from "@stello/shared";
import { AuthService } from "./auth.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public } from "../common/decorators";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
}
