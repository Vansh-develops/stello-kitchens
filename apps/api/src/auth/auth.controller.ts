import { Body, Controller, Get, Post } from "@nestjs/common";
import { LoginSchema, type LoginInput, type AuthUser } from "@petpooja/shared";
import { AuthService } from "./auth.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public } from "../common/decorators";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
