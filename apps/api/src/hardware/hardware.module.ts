import { Module } from "@nestjs/common";
import { CallWaiterController, HardwareController } from "./hardware.controller";
import { HardwareService } from "./hardware.service";
import { HARDWARE_BRIDGE, MockHardwareBridge } from "./hardware.bridge";

@Module({
  controllers: [HardwareController, CallWaiterController],
  providers: [HardwareService, { provide: HARDWARE_BRIDGE, useClass: MockHardwareBridge }],
})
export class HardwareModule {}
