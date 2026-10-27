import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import {
  ClaimPrintJobsSchema,
  CompletePrintJobSchema,
  CreatePrinterSchema,
  PrintRequestSchema,
  UpdatePrintSettingsSchema,
  UpdatePrinterSchema,
  type AuthUser,
  type ClaimPrintJobsInput,
  type CompletePrintJobInput,
  type CreatePrinterInput,
  type PrintRequestInput,
  type UpdatePrintSettingsInput,
  type UpdatePrinterInput,
} from "@stello/shared";
import { PrintingService } from "./printing.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

// Printer setup: owners/managers.
@RequirePermission("printers.manage")
@Controller("outlets/:outletId")
export class PrinterSetupController {
  constructor(private readonly svc: PrintingService) {}

  @Post("printers")
  create(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreatePrinterSchema)) body: CreatePrinterInput,
  ) {
    return this.svc.createPrinter(user, outletId, body);
  }

  @Patch("printers/:id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdatePrinterSchema)) body: UpdatePrinterInput,
  ) {
    return this.svc.updatePrinter(user, outletId, id, body);
  }

  @Delete("printers/:id")
  remove(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.deletePrinter(user, outletId, id);
  }

  @Post("printers/:id/test")
  test(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.testPrint(user, outletId, id);
  }

  @Put("print-settings")
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(UpdatePrintSettingsSchema)) body: UpdatePrintSettingsInput,
  ) {
    return this.svc.updateSettings(user, outletId, body);
  }
}

// Day-to-day printing: counter + kitchen staff, and the edge print agent.
@RequirePermission("printing.print")
@Controller()
export class PrintingController {
  constructor(private readonly svc: PrintingService) {}

  @Get("outlets/:outletId/printers")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.listPrinters(user, outletId);
  }

  @Get("outlets/:outletId/print-settings")
  settings(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.getSettings(user, outletId);
  }

  @Get("outlets/:outletId/print/bills/:orderId/preview")
  previewBill(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("orderId") orderId: string) {
    return this.svc.previewBill(user, outletId, orderId);
  }

  @Get("outlets/:outletId/print/kots/:kotId/preview")
  previewKot(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("kotId") kotId: string) {
    return this.svc.previewKot(user, outletId, kotId);
  }

  @Post("outlets/:outletId/print/bills/:orderId")
  printBill(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body(new ZodValidationPipe(PrintRequestSchema)) body: PrintRequestInput,
  ) {
    return this.svc.printBill(user, outletId, orderId, body);
  }

  @Post("outlets/:outletId/print/kots/:kotId")
  printKot(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("kotId") kotId: string,
    @Body(new ZodValidationPipe(PrintRequestSchema)) body: PrintRequestInput,
  ) {
    return this.svc.printKot(user, outletId, kotId, body);
  }

  @Post("outlets/:outletId/print/drawer")
  drawer(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(PrintRequestSchema)) body: PrintRequestInput,
  ) {
    return this.svc.kickDrawer(user, outletId, body);
  }

  @Get("outlets/:outletId/print/recent-bills")
  recentBills(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.recentBills(user, outletId);
  }

  @Get("outlets/:outletId/print-jobs")
  jobs(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("status") status?: string,
    @Query("orderId") orderId?: string,
  ) {
    return this.svc.listJobs(user, outletId, status || undefined, orderId || undefined);
  }

  @Post("outlets/:outletId/print-jobs/claim")
  claim(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ClaimPrintJobsSchema)) body: ClaimPrintJobsInput,
  ) {
    return this.svc.claim(user, outletId, body);
  }

  @Post("print-jobs/:id/complete")
  complete(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CompletePrintJobSchema)) body: CompletePrintJobInput,
  ) {
    return this.svc.complete(user, id, body);
  }

  @Post("print-jobs/:id/retry")
  retry(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.retry(user, id);
  }

  @Post("print-jobs/:id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.cancelJob(user, id);
  }

  @Post("print-jobs/:id/reprint")
  reprint(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.reprint(user, id);
  }
}
