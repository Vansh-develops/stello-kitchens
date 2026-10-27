import { Body, Controller, NotFoundException, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { SignupSchema, VerifyTokenSchema, type SignupInput, type VerifyTokenInput } from "@stello/shared";
import { SignupService } from "./signup.service";
import { AuthService } from "../auth/auth.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Public } from "../common/decorators";
import { SessionService } from "../session/session.service";

function assertSignupEnabled(): void {
  if (process.env.SIGNUP_PUBLIC_ENABLED !== "true") throw new NotFoundException();
}

@Controller()
export class SignupController {
  constructor(
    private readonly svc: SignupService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post("signup")
  async signup(@Body(new ZodValidationPipe(SignupSchema)) body: SignupInput) {
    assertSignupEnabled();
    await this.svc.start(body); // ignore return; never leak the token
    return { status: "verification_sent" };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("signup/verify")
  async verify(
    @Body(new ZodValidationPipe(VerifyTokenSchema)) body: VerifyTokenInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertSignupEnabled();
    const { ownerId } = await this.svc.verify(body.token);
    const user = await this.auth.resolveUser(ownerId);
    return this.sessions.issue(req, res, user);
  }
}
