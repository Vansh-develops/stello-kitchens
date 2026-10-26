// Fixed-width text layout for receipts. Everything here works in characters of
// the printer's font A at normal size: 32 per line on 58mm paper, 48 on 80mm.
// The same laid-out lines feed both the ESC/POS encoder and the HTML preview,
// so a browser-printed slip matches a thermal one column for column.

import { normalizeReceiptText } from "./codepages";

export type PaperWidth = 58 | 80;

/** Characters per line in font A at 1× width. */
export function charsPerLine(paper: PaperWidth): number {
  return paper === 58 ? 32 : 48;
}

/** Word-wrap to `width` columns; words longer than a line are hard-broken. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const clean = normalizeReceiptText(text).replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of clean.split(" ")) {
    let w = word;
    while (w.length > width) {
      // Flush what we have, then hard-break the long word.
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!w) continue;
    if (!current) current = w;
    else if (current.length + 1 + w.length <= width) current += " " + w;
    else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function pad(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
  const t = text.length > width ? text.slice(0, width) : text;
  const gap = width - t.length;
  if (align === "right") return " ".repeat(gap) + t;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + t + " ".repeat(gap - left);
  }
  return t + " ".repeat(gap);
}

export interface Column {
  text: string;
  width: number;
  align?: "left" | "right" | "center";
}

/**
 * Lay out one table row. Each cell wraps inside its own width; the row is as
 * tall as its tallest cell. Cells are separated by `gap` spaces. Trailing
 * spaces are trimmed so lines never exceed the paper.
 */
export function columns(cells: Column[], gap = 1): string[] {
  const wrapped = cells.map((c) => wrap(c.text, c.width));
  const height = Math.max(...wrapped.map((w) => w.length));
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    const parts = cells.map((c, i) => pad(wrapped[i][row] ?? "", c.width, c.align ?? "left"));
    out.push(parts.join(" ".repeat(gap)).replace(/\s+$/, ""));
  }
  return out;
}

/**
 * A label on the left and a value flush right. If both can't share a line the
 * label wraps and the value sits on the label's last line (or its own line).
 */
export function leftRight(left: string, right: string, width: number): string[] {
  const l = normalizeReceiptText(left);
  const r = normalizeReceiptText(right);
  if (l.length + 1 + r.length <= width) return [l + " ".repeat(width - l.length - r.length) + r];
  const leftLines = wrap(l, Math.max(1, width - r.length - 1));
  const last = leftLines.pop() ?? "";
  return [...leftLines, last + " ".repeat(Math.max(1, width - last.length - r.length)) + r];
}

/** Indian digit grouping with two decimals: 123456.5 → "1,23,456.50". */
export function formatAmount(value: number): string {
  const negative = value < 0;
  const [int, dec] = Math.abs(Math.round(value * 100) / 100).toFixed(2).split(".");
  let grouped = int;
  if (int.length > 3) {
    const head = int.slice(0, -3);
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + int.slice(-3);
  }
  return `${negative ? "-" : ""}${grouped}.${dec}`;
}

/** "26-10-2026 14:05" in the given IANA zone (default India). Deterministic, locale-free. */
export function formatDateTime(iso: string, timeZone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("day")}-${get("month")}-${get("year")} ${hour}:${get("minute")}`;
}
