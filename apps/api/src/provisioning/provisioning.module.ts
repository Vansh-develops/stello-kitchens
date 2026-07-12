import { Module } from "@nestjs/common";
import { ProvisioningService } from "./provisioning.service";
import { PlatformController } from "./platform.controller";

@Module({
  controllers: [PlatformController],
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
