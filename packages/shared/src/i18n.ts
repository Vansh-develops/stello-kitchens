// Internationalisation primitives shared by the dashboard (POS/KDS/console) and the
// diner app. Each app owns its own message catalogues; this module only defines the
// locale registry, the lookup/fallback rule and Indian-style number formatting, so
// every surface resolves strings and prints rupees identically.

/**
 * Locales the product ships. `complete` locales have every key translated; the rest
 * are scaffolded — their catalogues may be partial and fall back to English per key.
 */
export const SUPPORTED_LOCALES = [
  { code: "en", nativeName: "English", englishName: "English", complete: true },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", complete: true },
  { code: "mr", nativeName: "मराठी", englishName: "Marathi", complete: false },
  { code: "ta", nativeName: "தமிழ்", englishName: "Tamil", complete: false },
  { code: "te", nativeName: "తెలుగు", englishName: "Telugu", complete: false },
  { code: "bn", nativeName: "বাংলা", englishName: "Bengali", complete: false },
  { code: "gu", nativeName: "ગુજરાતી", englishName: "Gujarati", complete: false },
  { code: "kn", nativeName: "ಕನ್ನಡ", englishName: "Kannada", complete: false },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_CODES: readonly Locale[] = SUPPORTED_LOCALES.map((l) => l.code);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALE_CODES as readonly string[]).includes(value);
}

/**
 * Map any BCP-47-ish tag ("hi-IN", "ta_IN", " HI ") onto a supported locale by its
 * primary language subtag; anything unknown or empty becomes English.
 */
export function normalizeLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const primary = input.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

/** Display name of a locale in its own script (for language pickers). */
export function localeNativeName(locale: Locale): string {
  return SUPPORTED_LOCALES.find((l) => l.code === locale)?.nativeName ?? locale;
}

/** A flat key → message table. Messages may contain `{name}` placeholders. */
export type MessageDict = Readonly<Record<string, string | undefined>>;

export type TranslateParams = Readonly<Record<string, string | number>>;

/** Replace `{name}` placeholders; unknown placeholders are left as written. */
export function interpolate(message: string, params?: TranslateParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

/**
 * Resolve `key` for `locale`: the locale's catalogue, then English, then the key
 * itself (so a missing string is visible but never crashes the UI). Empty strings
 * count as missing — scaffold catalogues use them for "not yet translated".
 */
export function translate(
  dicts: Partial<Record<Locale, MessageDict>>,
  locale: Locale,
  key: string,
  params?: TranslateParams
): string {
  const message = dicts[locale]?.[key] || dicts[DEFAULT_LOCALE]?.[key] || key;
  return interpolate(message, params);
}

// ── Indian number formatting ────────────────────────────────────────────────
// Written by hand rather than via Intl "en-IN": ICU data differs between Node
// builds and browsers, and the POS, receipts and tests must agree exactly.

/** Group an unsigned digit string as 12,34,567 (last three, then pairs). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

export interface IndianNumberOptions {
  /** Fixed number of fraction digits (default 0). */
  decimals?: number;
}

/** 1234567.5 → "12,34,567.50" with `{ decimals: 2 }`. Rounds half away from zero. */
export function formatIndianNumber(n: number, opts: IndianNumberOptions = {}): string {
  if (!Number.isFinite(n)) return String(n);
  const decimals = Math.max(0, Math.min(6, Math.floor(opts.decimals ?? 0)));
  const scale = 10 ** decimals;
  // Round in scaled integers; the tiny epsilon keeps 1.005 → 1.01 despite binary float.
  const scaled = Math.round(Math.abs(n) * scale + 1e-7);
  const negative = n < 0 && scaled !== 0;
  const intPart = Math.floor(scaled / scale);
  const fracPart = scaled - intPart * scale;
  let out = groupIndian(String(intPart));
  if (decimals > 0) out += "." + String(fracPart).padStart(decimals, "0");
  return negative ? `-${out}` : out;
}

export interface INROptions {
  /**
   * Fraction digits. Default: 0 for whole rupees, 2 when there are paise —
   * so ₹250 prints as "₹250" and ₹99.5 as "₹99.50".
   */
  decimals?: number;
  /** Abbreviate large sums: ₹12.3 L (lakh), ₹1.2 Cr (crore). Below a lakh prints in full. */
  compact?: boolean;
}

const LAKH = 1_00_000;
const CRORE = 1_00_00_000;

/** Format rupees the Indian way: "₹12,34,567", "-₹50.25", "₹12.3 L", "₹1.2 Cr". */
export function formatINR(amount: number, opts: INROptions = {}): string {
  if (!Number.isFinite(amount)) return `₹${amount}`;
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);

  if (opts.compact && abs >= LAKH) {
    const decimals = opts.decimals ?? 1;
    // Decide the unit after rounding so 99,99,999 shows "₹1 Cr", not "₹100 L".
    const lakhs = Number((abs / LAKH).toFixed(decimals));
    const [value, unit] = lakhs >= 100 ? [abs / CRORE, "Cr"] : [abs / LAKH, "L"];
    const body = formatIndianNumber(value, { decimals }).replace(/\.0+$/, "");
    return `${sign}₹${body} ${unit}`;
  }

  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const decimals = opts.decimals ?? (hasPaise ? 2 : 0);
  const body = formatIndianNumber(abs, { decimals });
  // "-₹0" reads oddly; drop the sign when the rounded amount is zero.
  return /[1-9]/.test(body) ? `${sign}₹${body}` : `₹${body}`;
}
