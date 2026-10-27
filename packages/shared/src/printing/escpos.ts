// A small, dependency-free ESC/POS command encoder. Pure: it only produces bytes
// (a Uint8Array) and runs unchanged in Node (edge print agent) and the browser.
// Command references follow the Epson ESC/POS spec, which the 58/80mm thermal
// printers common in Indian restaurants (Epson TM, TVS RP, Xprinter, Rugtek…)
// implement.

import { CODEPAGE_TABLE, encodeText, type Codepage } from "./codepages";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = "left" | "center" | "right";
export type BarcodeType = "CODE128" | "CODE39" | "EAN13";
export type QrErrorLevel = "L" | "M" | "Q" | "H";

const clampInt = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

export class EscPosEncoder {
  private bytes: number[] = [];
  private cp: Codepage;

  constructor(options: { codepage?: Codepage } = {}) {
    this.cp = options.codepage ?? "CP437";
  }

  /** Append raw bytes verbatim. */
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i] & 0xff);
    return this;
  }

  /** ESC @ — reset the printer to power-on defaults (clears styles/buffer). */
  initialize(): this {
    return this.raw([ESC, 0x40]);
  }

  /** ESC t n — select the character code table. */
  codepage(codepage: Codepage): this {
    this.cp = codepage;
    return this.raw([ESC, 0x74, CODEPAGE_TABLE[codepage]]);
  }

  /** Text in the current code page (no newline). */
  text(value: string): this {
    return this.raw(encodeText(value, this.cp));
  }

  /** Text followed by LF. */
  line(value = ""): this {
    return this.text(value).newline();
  }

  newline(count = 1): this {
    for (let i = 0; i < count; i++) this.bytes.push(LF);
    return this;
  }

  /** ESC E n — emphasized (bold). */
  bold(on = true): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** ESC - n — underline: 0 off, 1 thin, 2 thick. */
  underline(mode: 0 | 1 | 2 | boolean = 1): this {
    const n = mode === true ? 1 : mode === false ? 0 : mode;
    return this.raw([ESC, 0x2d, n]);
  }

  /** GS B n — white-on-black reverse printing. */
  invert(on = true): this {
    return this.raw([GS, 0x42, on ? 1 : 0]);
  }

  /** ESC a n — justification. */
  align(value: Align): this {
    return this.raw([ESC, 0x61, value === "left" ? 0 : value === "center" ? 1 : 2]);
  }

  /** GS ! n — character size multipliers, 1–8 in each direction. */
  size(width = 1, height = 1): this {
    const w = clampInt(width, 1, 8) - 1;
    const h = clampInt(height, 1, 8) - 1;
    return this.raw([GS, 0x21, (w << 4) | h]);
  }

  /** ESC M n — font A (12×24) or the condensed font B (9×17). */
  font(value: "A" | "B"): this {
    return this.raw([ESC, 0x4d, value === "A" ? 0 : 1]);
  }

  /** ESC d n — print the buffer and feed n lines. */
  feed(lines = 1): this {
    return this.raw([ESC, 0x64, clampInt(lines, 0, 255)]);
  }

  /** A full-width horizontal rule made of `char`. */
  rule(width: number, char = "-"): this {
    return this.line(char.repeat(Math.max(0, width)));
  }

  /**
   * QR code via the GS ( k function set (model, module size, error level, store,
   * print). `size` is the module width in dots (1–16).
   */
  qrcode(data: string, options: { model?: 1 | 2; size?: number; errorLevel?: QrErrorLevel } = {}): this {
    const model = options.model ?? 2;
    const size = clampInt(options.size ?? 6, 1, 16);
    const ecc = { L: 48, M: 49, Q: 50, H: 51 }[options.errorLevel ?? "M"];
    // QR payloads are ASCII (UPI deep links, URLs); store the raw bytes.
    const payload = Array.from(data, (c) => c.charCodeAt(0) & 0xff);
    const storeLen = payload.length + 3;
    return this
      .raw([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, model === 1 ? 49 : 50, 0x00])
      .raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size])
      .raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ecc])
      .raw([GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30])
      .raw(payload)
      .raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
  }

  /**
   * 1D barcode via GS k (function B, length-prefixed). CODE128 data is sent in
   * code set B ("{B" prefix). `hri` places the human-readable digits.
   */
  barcode(
    data: string,
    type: BarcodeType = "CODE128",
    options: { height?: number; width?: number; hri?: "none" | "above" | "below" | "both" } = {},
  ): this {
    if (type === "EAN13" && !/^\d{12,13}$/.test(data)) throw new Error("EAN13 needs 12 or 13 digits");
    if (type === "CODE39" && !/^[0-9A-Z \-.$/+%]+$/.test(data)) throw new Error("CODE39 supports 0-9 A-Z and -.$/+% space");
    const hri = { none: 0, above: 1, below: 2, both: 3 }[options.hri ?? "below"];
    const m = { CODE128: 73, CODE39: 69, EAN13: 67 }[type];
    const body = type === "CODE128" ? `{B${data}` : data;
    const bytes = Array.from(body, (c) => c.charCodeAt(0) & 0x7f);
    if (bytes.length > 255) throw new Error("Barcode data too long");
    return this
      .raw([GS, 0x48, hri])
      .raw([GS, 0x68, clampInt(options.height ?? 80, 1, 255)])
      .raw([GS, 0x77, clampInt(options.width ?? 2, 2, 6)])
      .raw([GS, 0x6b, m, bytes.length])
      .raw(bytes);
  }

  /** GS V m — cut the paper (m 0 = full, 1 = partial). Feed past the head first. */
  cut(mode: "full" | "partial" = "partial"): this {
    return this.raw([GS, 0x56, mode === "full" ? 0 : 1]);
  }

  /**
   * ESC p m t1 t2 — pulse the cash-drawer kick-out connector. `pin` 0 = pin 2,
   * 1 = pin 5. Times are in milliseconds (sent in 2 ms units).
   */
  pulse(pin: 0 | 1 = 0, onMs = 100, offMs = 200): this {
    return this.raw([ESC, 0x70, pin, clampInt(onMs / 2, 0, 255), clampInt(offMs / 2, 0, 255)]);
  }

  /** The bytes encoded so far. */
  encode(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
