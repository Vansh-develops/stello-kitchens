import { Module } from "@nestjs/common";
import { InvitesService } from "./invites.service";
import { InvitesController, InviteAcceptController } from "./invites.controller";
import { PasswordResetService } from "./password-reset.service";

@Module({
  controllers: [InvitesController, InviteAcceptController],
  providers: [InvitesService, PasswordResetService],
})
export class AccountModule {}
