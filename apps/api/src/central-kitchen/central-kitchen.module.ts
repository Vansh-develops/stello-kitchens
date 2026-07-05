import { Module } from "@nestjs/common";
import { CentralKitchenController } from "./central-kitchen.controller";
import { CentralKitchenService } from "./central-kitchen.service";

@Module({
  controllers: [CentralKitchenController],
  providers: [CentralKitchenService],
})
export class CentralKitchenModule {}
