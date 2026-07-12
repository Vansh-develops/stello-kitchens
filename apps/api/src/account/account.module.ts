import { Module } from "@nestjs/common";
import { InvitesService } from "./invites.service";
import { InvitesController, InviteAcceptController } from "./invites.controller";
import { PasswordResetService } from "./password-reset.service";
import { SignupService } from "./signup.service";
import { SignupController } from "./signup.controller";
import { ProvisioningModule } from "../provisioning/provisioning.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [InvitesController, InviteAcceptController, SignupController],
  providers: [InvitesService, PasswordResetService, SignupService],
})
export class AccountModule {}
