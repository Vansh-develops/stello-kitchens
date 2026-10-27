import { PassThrough, type Writable } from "node:stream";
import ExcelJS from "exceljs";

export type CellValue = string | number | null;
export interface Column {
  header: string;
  /** "money" -> 2-dp number format in Excel; "pct" -> percentage. */
  format?: "money" | "pct" | "int";
  width?: number;
}
export interface Sheet {
  name: string;
  columns: Column[];
  rows: CellValue[][];
}

/** Neutralise spreadsheet formula injection in text cells (OWASP CSV injection). */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = safeText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Stream sheets as CSV (RFC 4180, CRLF, UTF-8 BOM so Excel opens ₹ and Hindi
 * names correctly). Several sheets become titled sections separated by a blank line.
 */
export async function writeCsv(sheets: Sheet[], out: Writable): Promise<void> {
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      if (out.write(chunk)) resolve();
      else out.once("drain", resolve).once("error", reject);
    });
  await write("﻿");
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    if (sheets.length > 1) await write(`${i ? "\r\n" : ""}${csvCell(s.name)}\r\n`);
    await write(s.columns.map((c) => csvCell(c.header)).join(",") + "\r\n");
    for (const row of s.rows) await write(row.map(csvCell).join(",") + "\r\n");
  }
}

const NUMFMT: Record<NonNullable<Column["format"]>, string> = { money: "#,##0.00", pct: "0.0%", int: "0" };

/** Excel sheet names: ≤31 chars, no []:*?/\ , unique. */
function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let n = 2;
  let candidate = base;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 28)} ${n++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Stream sheets as an .xlsx workbook (exceljs streaming writer; rows are committed as written). */
export async function writeXlsx(sheets: Sheet[], out: Writable): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = "Stello Kitchens";
  wb.created = new Date();
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = wb.addWorksheet(sheetName(s.name, used), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({
      header: c.header,
      width: c.width ?? Math.max(12, Math.min(40, c.header.length + 4)),
      style: c.format ? { numFmt: NUMFMT[c.format] } : {},
    }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    for (const row of s.rows) {
      ws.addRow(row.map((v) => (typeof v === "string" ? safeText(v) : v))).commit();
    }
    ws.commit();
  }
  await wb.commit();
}

/** Render to a Buffer (for email attachments). */
export async function renderToBuffer(sheets: Sheet[], format: "csv" | "xlsx"): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    sink.on("end", resolve);
    sink.on("error", reject);
  });
  if (format === "csv") {
    await writeCsv(sheets, sink);
    sink.end();
  } else {
    await writeXlsx(sheets, sink); // exceljs ends the stream on commit
  }
  await done;
  return Buffer.concat(chunks);
}
