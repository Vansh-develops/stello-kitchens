import { Body, Controller, Get, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { CreateInviteSchema, AcceptInviteSchema, type AuthUser, type CreateInviteInput, type AcceptInviteInput } from "@stello/shared";
import { InvitesService } from "./invites.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { SessionService } from "../session/session.service";
import { AuthService } from "../auth/auth.service";

@Controller("tenant")
export class InvitesController {
  constructor(private readonly svc: InvitesService) {}
  @RequirePermission("settings.manage")
  @Get("roles")
  roles(@CurrentUser() user: AuthUser) { return this.svc.roles(user); }
  @RequirePermission("settings.manage")
  @Post("invites")
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateInviteSchema)) body: CreateInviteInput) {
    return this.svc.create(user, body).then((r) => ({ inviteLink: r.inviteLink }));
  }
}

@Controller("invite")
export class InviteAcceptController {
  constructor(
    private readonly svc: InvitesService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("accept")
  async accept(
    @Body(new ZodValidationPipe(AcceptInviteSchema)) body: AcceptInviteInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user } = await this.svc.accept(body.token, body);
    return this.sessions.issue(req, res, await this.auth.resolveUser(user.id));
  }
}
