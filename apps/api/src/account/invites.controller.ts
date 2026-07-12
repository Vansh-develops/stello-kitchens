import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { CreateInviteSchema, AcceptInviteSchema, type AuthUser, type CreateInviteInput, type AcceptInviteInput } from "@stello/shared";
import { InvitesService } from "./invites.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

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
  constructor(private readonly svc: InvitesService, private readonly jwt: JwtService) {}
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("accept")
  async accept(@Body(new ZodValidationPipe(AcceptInviteSchema)) body: AcceptInviteInput) {
    const { user } = await this.svc.accept(body.token, body);
    const accessToken = await this.jwt.signAsync({ sub: user.id, tenantId: user.tenantId });
    return { accessToken, user };
  }
}
