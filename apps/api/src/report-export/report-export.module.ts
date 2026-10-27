import { Module } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { PaymentsModule } from "../payments/payments.module";
import { ReportExportController } from "./report-export.controller";
import { ReportExportService } from "./report-export.service";
import { ReportSchedulesController } from "./report-schedules.controller";
import { ReportSchedulesService } from "./report-schedules.service";

@Module({
  imports: [ReportsModule, PaymentsModule],
  controllers: [ReportExportController, ReportSchedulesController],
  providers: [ReportExportService, ReportSchedulesService],
})
export class ReportExportModule {}
