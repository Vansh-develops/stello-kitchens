import { describe, expect, it } from "vitest";
import { EscPosEncoder } from "./escpos";
import { CODEPAGES, codepageHighGlyphs, encodeText } from "./codepages";

const bytes = (e: EscPosEncoder) => Array.from(e.encode());

describe("EscPosEncoder", () => {
  it("encodes init, code page and text", () => {
    expect(bytes(new EscPosEncoder().initialize())).toEqual([0x1b, 0x40]);
    expect(bytes(new EscPosEncoder().codepage("CP437"))).toEqual([0x1b, 0x74, 0]);
    expect(bytes(new EscPosEncoder().codepage("CP850"))).toEqual([0x1b, 0x74, 2]);
    expect(bytes(new EscPosEncoder().codepage("CP858"))).toEqual([0x1b, 0x74, 19]);
    expect(bytes(new EscPosEncoder().line("Hi"))).toEqual([0x48, 0x69, 0x0a]);
    expect(bytes(new EscPosEncoder().newline(3))).toEqual([0x0a, 0x0a, 0x0a]);
  });

  it("encodes text styles, alignment and sizes", () => {
    expect(bytes(new EscPosEncoder().bold(true).bold(false))).toEqual([0x1b, 0x45, 1, 0x1b, 0x45, 0]);
    expect(bytes(new EscPosEncoder().underline(2).underline(false))).toEqual([0x1b, 0x2d, 2, 0x1b, 0x2d, 0]);
    expect(bytes(new EscPosEncoder().invert())).toEqual([0x1d, 0x42, 1]);
    expect(bytes(new EscPosEncoder().align("left").align("center").align("right"))).toEqual([
      0x1b, 0x61, 0, 0x1b, 0x61, 1, 0x1b, 0x61, 2,
    ]);
    expect(bytes(new EscPosEncoder().size(1, 1))).toEqual([0x1d, 0x21, 0x00]);
    expect(bytes(new EscPosEncoder().size(2, 2))).toEqual([0x1d, 0x21, 0x11]);
    expect(bytes(new EscPosEncoder().size(1, 2))).toEqual([0x1d, 0x21, 0x01]);
    expect(bytes(new EscPosEncoder().size(8, 8))).toEqual([0x1d, 0x21, 0x77]);
    expect(bytes(new EscPosEncoder().size(20, 0))).toEqual([0x1d, 0x21, 0x70]); // clamped
    expect(bytes(new EscPosEncoder().font("B"))).toEqual([0x1b, 0x4d, 1]);
    expect(bytes(new EscPosEncoder().feed(4))).toEqual([0x1b, 0x64, 4]);
  });

  it("draws a rule of the given width", () => {
    expect(bytes(new EscPosEncoder().rule(4, "="))).toEqual([0x3d, 0x3d, 0x3d, 0x3d, 0x0a]);
  });

  it("encodes a QR code with the GS ( k function set", () => {
    const out = bytes(new EscPosEncoder().qrcode("AB", { size: 5, errorLevel: "Q" }));
    expect(out).toEqual([
      0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 50, 0x00, // model 2
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 5, // module size
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 50, // error level Q
      0x1d, 0x28, 0x6b, 0x05, 0x00, 0x31, 0x50, 0x30, 0x41, 0x42, // store (len 2 + 3)
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30, // print
    ]);
  });

  it("splits a long QR payload length into pL/pH", () => {
    const data = "x".repeat(300);
    const out = bytes(new EscPosEncoder().qrcode(data));
    const store = out.indexOf(0x50) - 6; // GS ( k pL pH 31 50
    expect(out.slice(store, store + 8)).toEqual([0x1d, 0x28, 0x6b, 303 & 0xff, 303 >> 8, 0x31, 0x50, 0x30]);
  });

  it("encodes barcodes", () => {
    expect(bytes(new EscPosEncoder().barcode("AB1", "CODE128", { height: 60, width: 3, hri: "none" }))).toEqual([
      0x1d, 0x48, 0, 0x1d, 0x68, 60, 0x1d, 0x77, 3, 0x1d, 0x6b, 73, 5, 0x7b, 0x42, 0x41, 0x42, 0x31,
    ]);
    expect(bytes(new EscPosEncoder().barcode("890123456789", "EAN13")).slice(-15)).toEqual([
      0x1d, 0x6b, 67, 12, ...Array.from("890123456789", (c) => c.charCodeAt(0)),
    ].slice(-15));
    expect(() => new EscPosEncoder().barcode("12AB", "EAN13")).toThrow();
    expect(() => new EscPosEncoder().barcode("abc", "CODE39")).toThrow();
  });

  it("encodes cut and cash-drawer pulse", () => {
    expect(bytes(new EscPosEncoder().cut("full"))).toEqual([0x1d, 0x56, 0]);
    expect(bytes(new EscPosEncoder().cut())).toEqual([0x1d, 0x56, 1]);
    expect(bytes(new EscPosEncoder().pulse(0, 100, 200))).toEqual([0x1b, 0x70, 0, 50, 100]);
    expect(bytes(new EscPosEncoder().pulse(1, 1000, 1000))).toEqual([0x1b, 0x70, 1, 255, 255]);
  });
});

describe("code pages", () => {
  it("each page defines exactly 128 high glyphs", () => {
    for (const cp of CODEPAGES) expect(Array.from(codepageHighGlyphs(cp))).toHaveLength(128);
  });

  it("transcodes accents per page and substitutes the rupee sign", () => {
    expect(encodeText("é", "CP437")).toEqual([0x82]);
    expect(encodeText("Ã", "CP850")).toEqual([0xc7]);
    expect(encodeText("€", "CP858")).toEqual([0xd5]);
    expect(encodeText("€", "CP437")).toEqual([0x3f]);
    expect(encodeText("₹5", "CP437")).toEqual([0x52, 0x73, 0x2e, 0x35]);
    expect(encodeText("×", "CP850")).toEqual([0x9e]); // native glyph wins
    expect(encodeText("×", "CP437")).toEqual([0x78]); // stand-in
  });

  it("drops control bytes so text can't inject printer commands", () => {
    expect(encodeText("a\x1b@b\nc", "CP437")).toEqual([0x61, 0x40, 0x62, 0x0a, 0x63]);
  });
});
