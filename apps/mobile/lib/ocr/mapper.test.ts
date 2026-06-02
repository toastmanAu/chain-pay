import { describe, it, expect } from "vitest";
import { ocrToExtraction } from "./mapper";

const invoiceText = `
Acme Coffee Roasters
2026-05-15
Invoice #INV-2026-0421
BSB: 062-001
Account: 12345678
Subtotal: $100.00
GST: $10.00
Total: $110.00 AUD
`;

describe("ocrToExtraction", () => {
  it("extracts invoice number from a typical invoice", () => {
    const out = ocrToExtraction(invoiceText);
    expect(out.body.invoice_number).toBe("INV-2026-0421");
  });

  it("extracts total amount and currency", () => {
    const out = ocrToExtraction(invoiceText);
    expect(out.body.total).toBe(110);
    expect(out.body.currency).toBe("AUD");
  });

  it("extracts BSB + account when present", () => {
    const out = ocrToExtraction(invoiceText);
    const bank = out.body.bank as { bsb?: string; account_number?: string };
    expect(bank.bsb).toBe("062-001");
    expect(bank.account_number).toBe("12345678");
  });

  it("produces field_confidences in [0,1]", () => {
    const out = ocrToExtraction(invoiceText);
    const values = Object.values(out.field_confidences);
    expect(values.length).toBeGreaterThan(0);
    for (const c of values) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty body for unparseable input", () => {
    const out = ocrToExtraction("random gibberish without numbers");
    expect(Object.keys(out.body)).toHaveLength(0);
  });
});
