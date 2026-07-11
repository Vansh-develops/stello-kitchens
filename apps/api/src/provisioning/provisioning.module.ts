import { Module } from "@nestjs/common";
import { ProvisioningService } from "./provisioning.service";

@Module({ providers: [ProvisioningService], exports: [ProvisioningService] })
export class ProvisioningModule {}
