import { Module } from "@nestjs/common";
import { OwnerReportsController, ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  controllers: [ReportsController, OwnerReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
