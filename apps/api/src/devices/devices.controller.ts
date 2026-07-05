import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  CreateDeviceSchema,
  UpdateDeviceSchema,
  type AuthUser,
  type CreateDeviceInput,
  type UpdateDeviceInput,
} from "@petpooja/shared";
import { DevicesService } from "./devices.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@RequirePermission("devices.manage")
@Controller("outlets/:outletId/devices")
export class DevicesController {
  constructor(private readonly svc: DevicesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @Get("backup")
  backup(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.backup(user, outletId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateDeviceSchema)) body: CreateDeviceInput,
  ) {
    return this.svc.create(user, outletId, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateDeviceSchema)) body: UpdateDeviceInput,
  ) {
    return this.svc.update(user, id, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.remove(user, id);
  }
}

// Devices self-report liveness by their token (no user session).
@Public()
@Controller("public/devices")
export class DeviceHeartbeatController {
  constructor(private readonly svc: DevicesService) {}

  @Post("heartbeat")
  heartbeat(@Body() body: { deviceToken: string }) {
    return this.svc.heartbeat(body.deviceToken);
  }
}
