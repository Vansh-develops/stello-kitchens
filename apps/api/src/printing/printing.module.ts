import { Module } from "@nestjs/common";
import { PrinterSetupController, PrintingController } from "./printing.controller";
import { PrintingService } from "./printing.service";

@Module({
  controllers: [PrinterSetupController, PrintingController],
  providers: [PrintingService],
})
export class PrintingModule {}
