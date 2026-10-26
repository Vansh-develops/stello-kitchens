import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module";
import {
  CfdController,
  FloorController,
  PublicCfdController,
  PublicServerCallController,
  ReservationsController,
  ServerCallsController,
} from "./foh.controller";
import { FohEvents } from "./foh-events";
import { FloorService } from "./floor.service";
import { ReservationsService } from "./reservations.service";
import { ServerCallsService } from "./server-calls.service";
import { CfdService } from "./cfd.service";
import { CfdGateway } from "./cfd.gateway";

/** Front of house: floor plan + live floor, reservations, waitlist, server calls, customer display. */
@Module({
  imports: [CrmModule],
  controllers: [
    FloorController,
    ReservationsController,
    ServerCallsController,
    PublicServerCallController,
    CfdController,
    PublicCfdController,
  ],
  providers: [FohEvents, FloorService, ReservationsService, ServerCallsService, CfdService, CfdGateway],
  exports: [ServerCallsService],
})
export class FohModule {}
