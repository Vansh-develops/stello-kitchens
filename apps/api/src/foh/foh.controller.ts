import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  CallServerSchema,
  CfdPairSchema,
  CfdStateSchema,
  ReservationInputSchema,
  ReservationStatusSchema,
  SaveFloorPlanSchema,
  SeatSchema,
  ServerCallType,
  UpdateReservationSchema,
  WaiterAssignmentSchema,
  WaitlistInputSchema,
  type AuthUser,
  type CallServerInput,
  type CfdState,
  type ReservationInput,
  type ReservationStatus,
  type SaveFloorPlanInput,
  type SeatInput,
  type UpdateReservationInput,
  type WaiterAssignmentInput,
  type WaitlistInput,
} from "@stello/shared";
import { z } from "zod";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";
import { FloorService } from "./floor.service";
import { ReservationsService } from "./reservations.service";
import { ServerCallsService } from "./server-calls.service";
import { CfdService } from "./cfd.service";

const OptionalSeatSchema = z.object({ tableId: z.string().min(1).optional() });
const StaffCallSchema = z.object({ tableId: z.string().min(1), type: ServerCallType });

@Controller("outlets/:outletId/floor")
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @RequirePermission("orders.create")
  @Get()
  view(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.floor.view(user, outletId);
  }

  @RequirePermission("floor.manage")
  @Put("areas/:areaId/plan")
  savePlan(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("areaId") areaId: string,
    @Body(new ZodValidationPipe(SaveFloorPlanSchema)) body: SaveFloorPlanInput,
  ) {
    return this.floor.savePlan(user, outletId, areaId, body);
  }

  @RequirePermission("orders.create")
  @Post("tables/:tableId/request-bill")
  requestBill(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("tableId") tableId: string) {
    return this.floor.requestBill(user, outletId, tableId);
  }

  @RequirePermission("orders.create")
  @Get("waiters")
  waiters(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.floor.waiters(user, outletId);
  }

  @RequirePermission("floor.manage")
  @Put("waiters")
  assign(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(WaiterAssignmentSchema)) body: WaiterAssignmentInput,
  ) {
    return this.floor.assignWaiter(user, outletId, body);
  }
}

@RequirePermission("reservations.manage")
@Controller("outlets/:outletId")
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Get("reservations")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from: string, @Query("to") to: string) {
    return this.svc.list(user, outletId, new Date(from), new Date(to));
  }

  @Post("reservations")
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ReservationInputSchema)) body: ReservationInput,
  ) {
    return this.svc.create(user, outletId, body);
  }

  @Patch("reservations/:id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateReservationSchema)) body: UpdateReservationInput,
  ) {
    return this.svc.update(user, outletId, id, body);
  }

  @Post("reservations/:id/status")
  status(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReservationStatusSchema)) body: { status: ReservationStatus },
  ) {
    return this.svc.setStatus(user, outletId, id, body.status);
  }

  @Post("reservations/:id/seat")
  seat(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(OptionalSeatSchema)) body: { tableId?: string },
  ) {
    return this.svc.seat(user, outletId, id, body.tableId);
  }

  @Get("waitlist")
  waitlist(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.waitlist(user, outletId);
  }

  @Post("waitlist")
  addWaitlist(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(WaitlistInputSchema)) body: WaitlistInput,
  ) {
    return this.svc.addToWaitlist(user, outletId, body);
  }

  @Post("waitlist/:id/notify")
  notify(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.notify(user, outletId, id);
  }

  @Post("waitlist/:id/seat")
  seatWaitlist(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SeatSchema)) body: SeatInput,
  ) {
    return this.svc.seatFromWaitlist(user, outletId, id, body.tableId);
  }

  @Post("waitlist/:id/leave")
  leave(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.leaveWaitlist(user, outletId, id);
  }
}

@RequirePermission("orders.create")
@Controller("outlets/:outletId/server-calls")
export class ServerCallsController {
  constructor(private readonly calls: ServerCallsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("all") all?: string) {
    return this.calls.list(user, outletId, all === "1");
  }

  @Post()
  raise(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(StaffCallSchema)) body: { tableId: string; type: ServerCallType },
  ) {
    return this.calls.callByStaff(user, outletId, body.tableId, body.type);
  }

  @Post(":id/acknowledge")
  acknowledge(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.calls.acknowledge(user, outletId, id);
  }

  @Post(":id/resolve")
  resolve(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.calls.resolve(user, outletId, id);
  }
}

// Diner-facing "call a server" from the table QR (waiter / water / bill).
@Public()
@Controller("public/scan/t/:token")
export class PublicServerCallController {
  constructor(private readonly calls: ServerCallsService) {}

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("server-call")
  call(@Param("token") token: string, @Body(new ZodValidationPipe(CallServerSchema)) body: CallServerInput) {
    return this.calls.callFromTable(token, body.type);
  }
}

@RequirePermission("orders.settle")
@Controller("outlets/:outletId/cfd")
export class CfdController {
  constructor(private readonly cfd: CfdService) {}

  @Post("pair")
  pair(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CfdPairSchema)) body: { code: string },
  ) {
    return this.cfd.pair(user, outletId, body.code);
  }

  @Put(":id/state")
  state(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CfdStateSchema)) body: CfdState,
  ) {
    return this.cfd.pushState(user, outletId, id, body);
  }

  @Delete(":id")
  unpair(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.cfd.unpair(user, outletId, id);
  }
}

// The display itself: unauthenticated, identified by its secret session token.
@Public()
@Controller("public/cfd")
export class PublicCfdController {
  constructor(private readonly cfd: CfdService) {}

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("sessions")
  start() {
    return this.cfd.start();
  }

  @Get("sessions/:token")
  get(@Param("token") token: string) {
    return this.cfd.byToken(token);
  }
}
