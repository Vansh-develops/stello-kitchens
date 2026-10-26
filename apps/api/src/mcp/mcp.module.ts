import { Module } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { McpController } from "./mcp.controller";
import { PublicApiController } from "./public-api.controller";
import { PublicApiService } from "./public-api.service";

@Module({
  imports: [ReportsModule],
  controllers: [PublicApiController, McpController],
  providers: [PublicApiService],
})
export class McpModule {}
