import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  CustomReportSchema,
  REPORT_EXPORT_KEYS,
  type AuthUser,
  type CustomReportInput,
  type ExportFormat,
  type ReportExportKey,
} from "@stello/shared";
import { ReportExportService } from "./report-export.service";
import { writeCsv, writeXlsx, type Sheet } from "./report-writer";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseFormat(f?: string): ExportFormat {
  const v = (f ?? "csv").toLowerCase();
  if (v !== "csv" && v !== "xlsx") throw new BadRequestException("format must be csv or xlsx");
  return v;
}

/** Stream sheets to the response as a download. Data is fetched before any byte is written. */
export async function sendSheets(res: Response, sheets: Sheet[], format: ExportFormat, basename: string) {
  const filename = `${basename.replace(/[^a-zA-Z0-9._-]+/g, "-")}.${format}`;
  res.setHeader(
    "Content-Type",
    format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  if (format === "csv") {
    await writeCsv(sheets, res);
    res.end();
  } else {
    await writeXlsx(sheets, res);
  }
}

@RequirePermission("reports.view", "reports.export")
@Controller("outlets/:outletId/reports/export")
export class ReportExportController {
  constructor(private readonly svc: ReportExportService) {}

  /**
   * GET …/reports/export?report=overview|payments|…|all&format=csv|xlsx&from=YYYY-MM-DD&to=YYYY-MM-DD
   * `all` bundles every report as one workbook (a sheet each) or sectioned CSV.
   */
  @Get()
  async export(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Res() res: Response,
    @Query("report") report?: string,
    @Query("format") format?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    const fmt = parseFormat(format);
    const t = to || ymd(new Date());
    const f = from || t;
    let keys: ReportExportKey[];
    if (!report || report === "all") keys = [...REPORT_EXPORT_KEYS];
    else if ((REPORT_EXPORT_KEYS as readonly string[]).includes(report)) keys = [report as ReportExportKey];
    else throw new BadRequestException(`report must be one of: all, ${REPORT_EXPORT_KEYS.join(", ")}`);
    const sheets = await this.svc.sheets(user, outletId, keys, f, t);
    await sendSheets(res, sheets, fmt, `stello-${report ?? "all"}-${f}_${t}`);
  }

  /** The custom report builder's current query, exported. */
  @Post("custom")
  async custom(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Res() res: Response,
    @Body(new ZodValidationPipe(CustomReportSchema)) body: CustomReportInput,
    @Query("format") format?: string,
  ) {
    const fmt = parseFormat(format);
    const sheets = await this.svc.customSheet(user, outletId, body);
    await sendSheets(res, sheets, fmt, `stello-custom-${body.dimension}-${body.metric}-${body.from}_${body.to}`);
  }
}
