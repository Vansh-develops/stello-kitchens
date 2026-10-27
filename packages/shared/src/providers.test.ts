import { describe, expect, it } from "vitest";
import { CancelIrnSchema, GenerateIrnSchema, MessagingConfigSchema, nationalPhone, SmsTemplateSchema } from "./providers";

describe("provider schemas", () => {
  it("normalises Indian mobiles to the 10-digit national form", () => {
    expect(nationalPhone("+91 98765-43210")).toBe("9876543210");
    expect(nationalPhone("09876543210")).toBe("9876543210");
    expect(nationalPhone("9876543210")).toBe("9876543210");
  });

  it("validates GSTINs and IRN cancel reason codes", () => {
    expect(GenerateIrnSchema.safeParse({ buyerGstin: "27aapfu0939f1zv" }).success).toBe(true);
    expect(GenerateIrnSchema.safeParse({ buyerGstin: "27AAPFU0939F1" }).success).toBe(false);
    expect(CancelIrnSchema.parse({})).toEqual({ reason: "Cancelled by merchant", reasonCode: "4" });
    expect(CancelIrnSchema.safeParse({ reasonCode: "5" }).success).toBe(false);
  });

  it("requires numeric DLT template ids and a 6-char sender id", () => {
    expect(SmsTemplateSchema.safeParse({ templateId: "6512abc", dltTemplateId: "1207161234567890123" }).success).toBe(true);
    expect(SmsTemplateSchema.safeParse({ templateId: "x", dltTemplateId: "DLT-1" }).success).toBe(false);
    const base = { smsEnabled: true, whatsappEnabled: true, emailEnabled: true, otpChannel: "SMS", templates: {}, ratePerMinute: 60, lowStockEnabled: true, lowStockRecipients: [] };
    expect(MessagingConfigSchema.safeParse({ ...base, smsSenderId: "STELLO" }).success).toBe(true);
    expect(MessagingConfigSchema.safeParse({ ...base, smsSenderId: "STEL" }).success).toBe(false);
  });
});
