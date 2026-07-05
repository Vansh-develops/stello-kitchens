import { Module } from "@nestjs/common";
import { CombosController } from "./combos.controller";
import { CombosService } from "./combos.service";

@Module({
  controllers: [CombosController],
  providers: [CombosService],
  exports: [CombosService],
})
export class CombosModule {}
