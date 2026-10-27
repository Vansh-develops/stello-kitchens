import { Module } from "@nestjs/common";
import { StaffController } from "./staff.controller";
import { StaffService } from "./staff.service";
import { RosterService } from "./roster.service";
import { PayrollService } from "./payroll.service";

@Module({
  controllers: [StaffController],
  providers: [StaffService, RosterService, PayrollService],
  exports: [StaffService, PayrollService],
})
export class StaffModule {}
