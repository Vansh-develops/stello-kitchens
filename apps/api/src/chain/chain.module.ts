import { Module } from "@nestjs/common";
import { ChainController, MasterOverridesController } from "./chain.controller";
import { ChainService } from "./chain.service";

@Module({
  controllers: [ChainController, MasterOverridesController],
  providers: [ChainService],
  exports: [ChainService],
})
export class ChainModule {}
