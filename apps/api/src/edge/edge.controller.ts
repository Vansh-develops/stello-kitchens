import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ClaimPrintJobsSchema,
  CompletePrintJobSchema,
  EdgeActivateSchema,
  EdgePushSchema,
  EdgeResolveConflictSchema,
  EdgeStaffPinSchema,
  type AuthUser,
  type ClaimPrintJobsInput,
  type CompletePrintJobInput,
  type EdgeActivateInput,
  type EdgePushInput,
  type EdgeResolveConflictInput,
  type EdgeStaffPinInput,
} from "@stello/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { CurrentEdgeDevice, EdgeDeviceGuard, type EdgeDeviceContext } from "./edge-device.guard";
import { EdgeFeedService } from "./edge-feed.service";
import { EdgeIngestService } from "./edge-ingest.service";
import { EdgeAdminService } from "./edge-admin.service";
import { PrintingService } from "../printing/printing.service";

// Device-authenticated sync surface (no user session; see EdgeDeviceGuard).
@Public()
@UseGuards(EdgeDeviceGuard)
@Controller("edge/device")
export class EdgeDeviceController {
  constructor(
    private readonly feed: EdgeFeedService,
    private readonly ingest: EdgeIngestService,
    private readonly printing: PrintingService,
  ) {}

  @Get("feed")
  pull(@CurrentEdgeDevice() device: EdgeDeviceContext, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.feed.feed(device, cursor, limit);
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Post("push")
  push(@CurrentEdgeDevice() device: EdgeDeviceContext, @Body(new ZodValidationPipe(EdgePushSchema)) body: EdgePushInput) {
    return this.ingest.push(device, body);
  }

  // The sidecar's print agent drains this outlet's LAN/USB print queue with the
  // device token (it holds no user session).
  @Post("print-jobs/claim")
  claimPrintJobs(@CurrentEdgeDevice() device: EdgeDeviceContext, @Body(new ZodValidationPipe(ClaimPrintJobsSchema)) body: ClaimPrintJobsInput) {
    return this.printing.claimForDevice(device.tenantId, device.outletId, device.edgeDeviceId, body);
  }

  @Post("print-jobs/:id/complete")
  completePrintJob(
    @CurrentEdgeDevice() device: EdgeDeviceContext,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CompletePrintJobSchema)) body: CompletePrintJobInput,
  ) {
    return this.printing.completeForDevice(device.tenantId, device.outletId, device.edgeDeviceId, id, body);
  }
}

@Controller("outlets/:outletId/edge")
export class EdgeAdminController {
  constructor(private readonly svc: EdgeAdminService) {}

  @RequirePermission("edge.activate")
  @Post("activate")
  activate(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(EdgeActivateSchema)) body: EdgeActivateInput,
  ) {
    return this.svc.activate(user, outletId, body);
  }

  @RequirePermission("edge.manage")
  @Get("devices")
  devices(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.devices(user, outletId);
  }

  @RequirePermission("edge.manage")
  @Post("devices/:id/revoke")
  revoke(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.revoke(user, outletId, id);
  }

  @RequirePermission("edge.manage")
  @Get("staff")
  staff(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.staff(user, outletId);
  }

  @RequirePermission("edge.manage")
  @Put("staff/:userId/pin")
  setPin(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(EdgeStaffPinSchema)) body: EdgeStaffPinInput,
  ) {
    return this.svc.setPin(user, outletId, userId, body.pin);
  }

  @RequirePermission("edge.manage")
  @Delete("staff/:userId/pin")
  clearPin(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("userId") userId: string) {
    return this.svc.clearPin(user, outletId, userId);
  }

  @RequirePermission("edge.manage")
  @Get("conflicts")
  conflicts(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("status") status?: string) {
    return this.svc.conflicts(user, outletId, status);
  }

  @RequirePermission("edge.manage")
  @Post("conflicts/:id/resolve")
  resolve(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(EdgeResolveConflictSchema)) body: EdgeResolveConflictInput,
  ) {
    return this.svc.resolve(user, outletId, id, body.note);
  }

  @RequirePermission("edge.manage")
  @Get("series")
  series(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.series(user, outletId);
  }
}
