import { Module } from "@nestjs/common";
import { OutletsController } from "./outlets.controller";

@Module({
  controllers: [OutletsController],
})
export class OutletsModule {}
