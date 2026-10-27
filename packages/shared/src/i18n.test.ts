import { describe, it, expect } from "vitest";
import {
  SUPPORTED_LOCALES, isLocale, normalizeLocale, translate, interpolate,
  formatIndianNumber, formatINR, localeNativeName, type MessageDict, type Locale,
} from "./i18n";

const dicts: Partial<Record<Locale, MessageDict>> = {
  en: { greet: "Hello {name}", total: "Total", only_en: "English only", n: "{count} items" },
  hi: { greet: "नमस्ते {name}", total: "कुल", blank: "" },
  mr: {},
};

describe("locale registry", () => {
  it("ships en + hi complete and six scaffolded Indian locales", () => {
    expect(SUPPORTED_LOCALES.map((l) => l.code)).toEqual(["en", "hi", "mr", "ta", "te", "bn", "gu", "kn"]);
    expect(SUPPORTED_LOCALES.filter((l) => l.complete).map((l) => l.code)).toEqual(["en", "hi"]);
    expect(localeNativeName("hi")).toBe("हिन्दी");
    expect(localeNativeName("ta")).toBe("தமிழ்");
  });

  it("isLocale accepts only supported codes", () => {
    expect(isLocale("hi")).toBe(true);
    expect(isLocale("kn")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("hi-IN")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("normalizeLocale maps tags onto supported locales", () => {
    expect(normalizeLocale("hi-IN")).toBe("hi");
    expect(normalizeLocale("ta_IN")).toBe("ta");
    expect(normalizeLocale(" BN ")).toBe("bn");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBe("en");
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
  });
});

describe("translate", () => {
  it("uses the requested locale when the key exists", () => {
    expect(translate(dicts, "hi", "total")).toBe("कुल");
  });

  it("falls back hi → en for a missing Hindi key", () => {
    expect(translate(dicts, "hi", "only_en")).toBe("English only");
  });

  it("treats an empty-string message as missing", () => {
    expect(translate(dicts, "hi", "blank")).toBe("blank");
  });

  it("falls back to the key when English is missing too", () => {
    expect(translate(dicts, "hi", "no.such.key")).toBe("no.such.key");
  });

  it("scaffold locales (empty or absent catalogue) fall back to English", () => {
    expect(translate(dicts, "mr", "total")).toBe("Total");
    expect(translate(dicts, "kn", "total")).toBe("Total");
  });

  it("interpolates {name} placeholders in the resolved message", () => {
    expect(translate(dicts, "hi", "greet", { name: "रवि" })).toBe("नमस्ते रवि");
    expect(translate(dicts, "mr", "greet", { name: "Asha" })).toBe("Hello Asha");
    expect(translate(dicts, "en", "n", { count: 3 })).toBe("3 items");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(interpolate("no params {x}")).toBe("no params {x}");
  });
});

describe("formatIndianNumber", () => {
  it("groups by lakh and crore", () => {
    expect(formatIndianNumber(0)).toBe("0");
    expect(formatIndianNumber(7)).toBe("7");
    expect(formatIndianNumber(999)).toBe("999");
    expect(formatIndianNumber(1000)).toBe("1,000");
    expect(formatIndianNumber(99999)).toBe("99,999");
    expect(formatIndianNumber(100000)).toBe("1,00,000");
    expect(formatIndianNumber(1234567)).toBe("12,34,567");
    expect(formatIndianNumber(12345678)).toBe("1,23,45,678");
    expect(formatIndianNumber(1234567890)).toBe("1,23,45,67,890");
  });

  it("formats decimals with fixed fraction digits", () => {
    expect(formatIndianNumber(1234567.5, { decimals: 2 })).toBe("12,34,567.50");
    expect(formatIndianNumber(0.5, { decimals: 2 })).toBe("0.50");
    expect(formatIndianNumber(1.005, { decimals: 2 })).toBe("1.01");
    expect(formatIndianNumber(999.999, { decimals: 2 })).toBe("1,000.00");
    expect(formatIndianNumber(12.6)).toBe("13");
  });

  it("handles negatives", () => {
    expect(formatIndianNumber(-1234567)).toBe("-12,34,567");
    expect(formatIndianNumber(-50.25, { decimals: 2 })).toBe("-50.25");
    expect(formatIndianNumber(-0.001, { decimals: 2 })).toBe("0.00");
  });
});

describe("formatINR", () => {
  it("prints whole rupees without decimals and paise with two", () => {
    expect(formatINR(1234567)).toBe("₹12,34,567");
    expect(formatINR(250)).toBe("₹250");
    expect(formatINR(99.5)).toBe("₹99.50");
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(1234567.5)).toBe("₹12,34,567.50");
  });

  it("respects an explicit decimals option", () => {
    expect(formatINR(250, { decimals: 2 })).toBe("₹250.00");
    expect(formatINR(99.5, { decimals: 0 })).toBe("₹100");
  });

  it("puts the minus sign before the rupee symbol", () => {
    expect(formatINR(-1500)).toBe("-₹1,500");
    expect(formatINR(-50.25)).toBe("-₹50.25");
    expect(formatINR(-0.001)).toBe("₹0");
  });

  it("compacts lakhs and crores", () => {
    expect(formatINR(1234567, { compact: true })).toBe("₹12.3 L");
    expect(formatINR(100000, { compact: true })).toBe("₹1 L");
    expect(formatINR(12345678, { compact: true })).toBe("₹1.2 Cr");
    expect(formatINR(9999999, { compact: true })).toBe("₹1 Cr");
    expect(formatINR(1234567890, { compact: true })).toBe("₹123.5 Cr");
    expect(formatINR(-2550000, { compact: true })).toBe("-₹25.5 L");
  });

  it("prints sub-lakh amounts in full even when compact", () => {
    expect(formatINR(99999, { compact: true })).toBe("₹99,999");
    expect(formatINR(450, { compact: true })).toBe("₹450");
  });
});
