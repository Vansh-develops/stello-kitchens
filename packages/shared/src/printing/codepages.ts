// Single-byte code pages for thermal receipt printers. ESC/POS printers render
// bytes 0x00–0x7F as ASCII and 0x80–0xFF from the selected code page, so text
// must be transcoded byte-by-byte before it is sent. We ship the three pages
// virtually every 58/80mm printer sold in India supports out of the box.
//
// The `escPosTable` number is the ESC t n argument. Epson numbering is the de
// facto standard (0 = PC437, 2 = PC850, 19 = PC858); most clones follow it, but
// a few firmware builds number differently — which is why the outlet can pick
// the page per printer and why this is on the hardware-validation checklist.

export type Codepage = "CP437" | "CP850" | "CP858";

export const CODEPAGES: Codepage[] = ["CP437", "CP850", "CP858"];

/** ESC t n selector for each page (Epson numbering). */
export const CODEPAGE_TABLE: Record<Codepage, number> = { CP437: 0, CP850: 2, CP858: 19 };

// 0x80–0xFF for each page, in byte order.
const HIGH_437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const HIGH_850 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
// CP858 is CP850 with the dotless ı at 0xD5 replaced by the euro sign.
const HIGH_858 = HIGH_850.slice(0, 0x55) + "€" + HIGH_850.slice(0x56);

const HIGH: Record<Codepage, string> = { CP437: HIGH_437, CP850: HIGH_850, CP858: HIGH_858 };

const reverse = (high: string) => {
  const map = new Map<string, number>();
  Array.from(high).forEach((ch, i) => map.set(ch, 0x80 + i));
  return map;
};
const LOOKUP: Record<Codepage, Map<string, number>> = {
  CP437: reverse(HIGH_437),
  CP850: reverse(HIGH_850),
  CP858: reverse(HIGH_858),
};

/**
 * Characters receipts commonly contain that no supported page has. Applied
 * before transcoding so "₹" never prints as "?". Thermal printers have no Indic
 * glyphs in these pages; Devanagari etc. needs raster printing (not supported).
 */
const SUBSTITUTE: Record<string, string> = {
  "₹": "Rs.",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "*",
  "×": "x",
  "→": "->",
  "↳": ">",
  " ": " ",
  "\t": " ",
};

/** Replace characters no receipt code page can print with ASCII stand-ins. */
export function normalizeReceiptText(text: string): string {
  let out = "";
  for (const ch of text) out += SUBSTITUTE[ch] ?? ch;
  return out;
}

/**
 * Transcode a string to single-byte code page bytes. Unmappable characters
 * become "?" (0x3F). Newlines pass through; other control bytes are dropped so
 * user-entered text can never smuggle printer commands.
 */
export function encodeText(text: string, codepage: Codepage): number[] {
  const bytes: number[] = [];
  const lookup = LOOKUP[codepage];
  for (const ch of text) {
    // Keep a page's native glyph (e.g. "×" in CP850) before falling back to a stand-in.
    const native = lookup.get(ch);
    if (native !== undefined) {
      bytes.push(native);
      continue;
    }
    const sub = SUBSTITUTE[ch];
    if (sub !== undefined) {
      for (const s of sub) bytes.push(s.charCodeAt(0));
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code === 0x0a) bytes.push(code);
    else if (code >= 0x20 && code < 0x7f) bytes.push(code);
    else if (code < 0x20 || code === 0x7f) continue;
    else bytes.push(0x3f);
  }
  return bytes;
}

/** Exposed for tests: the 128 high glyphs of a page. */
export function codepageHighGlyphs(codepage: Codepage): string {
  return HIGH[codepage];
}
