import { Module } from "@nestjs/common";
import { DeviceHeartbeatController, DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";

@Module({
  controllers: [DevicesController, DeviceHeartbeatController],
  providers: [DevicesService],
})
export class DevicesModule {}
