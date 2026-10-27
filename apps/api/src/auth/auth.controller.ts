import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import {
  LoginSchema,
  type LoginInput,
  type AuthUser,
  ForgotPasswordSchema,
  type ForgotPasswordInput,
  ResetPasswordSchema,
  type ResetPasswordInput,
  MfaChallengeSchema,
  type MfaChallengeInput,
  MfaTokenSchema,
  MfaEnrollConfirmSchema,
  type MfaEnrollConfirmInput,
} from "@stello/shared";
import { AuthService } from "./auth.service";
import { PasswordResetService } from "../account/password-reset.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public } from "../common/decorators";
import { SessionService } from "../session/session.service";
import { clearSessionCookies } from "../session/cookies";
import { MfaService } from "../mfa/mfa.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly prisma: PrismaService,
  ) {}

  // Tight limit to blunt credential brute-force: 10 attempts / minute per IP.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @Post("login")
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.authenticate(body.email, body.password);
    // Second factor: verify an enrolled user, or force enrolment when the
    // tenant requires owners to use 2FA. Only a 5-minute step-up token leaves.
    const mfa = await this.mfa.loginRequirement(user);
    if (mfa !== "none") return { mfa, mfaToken: await this.sessions.stepUpToken(user.id, user.tenantId, "mfa") };
    await this.auth.recordLogin(user);
    return this.sessions.issue(req, res, user);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @HttpCode(200)
  @Post("mfa/challenge")
  async mfaChallenge(
    @Body(new ZodValidationPipe(MfaChallengeSchema)) body: MfaChallengeInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.stepUpUser(body.mfaToken);
    await this.mfa.verify(user, { code: body.code, recoveryCode: body.recoveryCode });
    await this.auth.recordLogin(user);
    return this.sessions.issue(req, res, user);
  }

  /** Forced enrolment during login (tenant policy): returns the secret for the QR. */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @HttpCode(200)
  @Post("mfa/enroll/start")
  async mfaEnrollStart(@Body(new ZodValidationPipe(MfaTokenSchema)) body: { mfaToken: string }) {
    const user = await this.stepUpUser(body.mfaToken);
    return this.mfa.beginSetup(user);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @HttpCode(200)
  @Post("mfa/enroll/confirm")
  async mfaEnrollConfirm(
    @Body(new ZodValidationPipe(MfaEnrollConfirmSchema)) body: MfaEnrollConfirmInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.stepUpUser(body.mfaToken);
    const { recoveryCodes } = await this.mfa.confirmSetup(user, body.code);
    await this.auth.recordLogin(user);
    return { ...(await this.sessions.issue(req, res, user)), recoveryCodes };
  }

  /** Clears the browser session cookies. Public so an expired session can still sign out. */
  @Public()
  @HttpCode(200)
  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    clearSessionCookies(res);
    return { status: "ok" };
  }

  /** Revoke every session for this user (all devices) by bumping tokenVersion. */
  @HttpCode(200)
  @Post("logout-all")
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "SESSIONS_REVOKED", entity: "user", entityId: user.id },
    });
    clearSessionCookies(res);
    return { status: "ok" };
  }

  private async stepUpUser(mfaToken: string): Promise<AuthUser> {
    const claims = await this.sessions.readStepUpToken(mfaToken, "mfa");
    if (!claims) throw new UnauthorizedException("Sign-in step expired. Please sign in again.");
    return this.auth.resolveUser(claims.sub);
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
