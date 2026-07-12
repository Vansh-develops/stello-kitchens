import { Body, Controller, NotFoundException, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { SignupSchema, VerifyTokenSchema, type SignupInput, type VerifyTokenInput } from "@stello/shared";
import { SignupService } from "./signup.service";
import { AuthService } from "../auth/auth.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Public } from "../common/decorators";

function assertSignupEnabled(): void {
  if (process.env.SIGNUP_PUBLIC_ENABLED !== "true") throw new NotFoundException();
}

@Controller()
export class SignupController {
  constructor(
    private readonly svc: SignupService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
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
  async verify(@Body(new ZodValidationPipe(VerifyTokenSchema)) body: VerifyTokenInput) {
    assertSignupEnabled();
    const { ownerId, tenantId } = await this.svc.verify(body.token);
    const user = await this.auth.resolveUser(ownerId);
    const accessToken = await this.jwt.signAsync({ sub: ownerId, tenantId });
    return { accessToken, user };
  }
}
