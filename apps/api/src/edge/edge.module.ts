import { Module } from "@nestjs/common";
import { EdgeAdminController, EdgeDeviceController } from "./edge.controller";
import { EdgeAdminService } from "./edge-admin.service";
import { EdgeDeviceGuard } from "./edge-device.guard";
import { EdgeFeedService } from "./edge-feed.service";
import { EdgeIngestService } from "./edge-ingest.service";
import { PrintingModule } from "../printing/printing.module";

// Offline edge POS: device activation, per-outlet change feed, outbox ingest
// with conflict capture, and the console's PIN / conflict / series views.
@Module({
  imports: [PrintingModule],
  controllers: [EdgeDeviceController, EdgeAdminController],
  providers: [EdgeAdminService, EdgeDeviceGuard, EdgeFeedService, EdgeIngestService],
})
export class EdgeModule {}
