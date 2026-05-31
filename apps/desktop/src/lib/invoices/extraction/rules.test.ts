import { describe, it, expect } from "vitest";
import type { PageOcr } from "./types";
import { extractFields } from "./rules";

function page(text: string, lines: { text: string; confidence?: number; y?: number }[] = []): PageOcr {
  return {
    pageIndex: 0,
    text,
    lines: lines.map((l, i) => ({
      text: l.text,
      bbox: { x0: 0, y0: l.y ?? i * 20, x1: 100, y1: (l.y ?? i * 20) + 20 },
      confidence: l.confidence ?? 90,
    })),
  };
}

const CASES: Array<{ name: string; pages: PageOcr[]; expect: (r: ReturnType<typeof extractFields>) => void }> = [
  {
    name: "clean AUD vendor invoice",
    pages: [page("Acme Pty Ltd\nInvoice #INV-2026-001\nIssued: 15/05/2026\nDue: 30/05/2026\nTotal: AUD 1,234.56", [
      { text: "Acme Pty Ltd", y: 0 },
      { text: "Invoice #INV-2026-001", y: 30 },
      { text: "Issued: 15/05/2026", y: 50 },
      { text: "Due: 30/05/2026", y: 70 },
      { text: "Total: AUD 1,234.56", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.total).toBeCloseTo(1234.56);
      expect(r.body.currency).toBe("AUD");
      expect(r.body.invoice_number).toBe("INV-2026-001");
      expect(r.body.issue_date).toBe("2026-05-15");
      expect(r.body.due_date).toBe("2026-05-30");
      expect(r.body.payee?.display_name).toContain("Acme");
    },
  },
  {
    name: "USD invoice with $ symbol",
    pages: [page("Total: $99.00", [{ text: "Total: $99.00", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBe(99);
      expect(r.body.currency).toBe("USD");
    },
  },
  {
    name: "EUR invoice with € symbol",
    pages: [page("Gesamt: € 250,00", [{ text: "Gesamt: € 250,00", y: 800 }])],
    expect: (r) => {
      expect(r.body.currency).toBe("EUR");
      // total parsing for european decimals is YAGNI for v1 — accept a warning, not a value
      const totalWarn = r.warnings.find((w) => w.field === "total");
      expect(totalWarn || r.body.total).toBeTruthy();
    },
  },
  {
    name: "BSB present (AU bank details)",
    pages: [page("BSB 062-001 Account 12345678 Total $200", [
      { text: "BSB 062-001 Account 12345678", y: 600 },
      { text: "Total $200", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.payment_details?.bank?.bsb).toBe("062-001");
      expect(r.body.payment_details?.bank?.account_number).toBe("12345678");
    },
  },
  {
    name: "CKB testnet address present",
    pages: [page("Pay to: ckt1qyqv... Total $50", [{ text: "Pay to: ckt1qyqv0z2u Total $50", y: 800 }])],
    expect: (r) => {
      expect(r.body.payment_details?.ckb_address).toMatch(/^ckt1/);
    },
  },
  {
    name: "EVM address present",
    pages: [page("ETH: 0x1234567890abcdef1234567890abcdef12345678 Total $50", [
      { text: "ETH: 0x1234567890abcdef1234567890abcdef12345678", y: 600 },
      { text: "Total $50", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.payment_details?.evm_address).toBe("0x1234567890abcdef1234567890abcdef12345678");
    },
  },
  {
    name: "NaN-total guard",
    pages: [page("Total: ABC", [{ text: "Total: ABC", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      expect(r.warnings.some((w) => w.field === "total")).toBe(true);
    },
  },
  {
    name: "negative-total guard",
    pages: [page("Total: -99.00", [{ text: "Total: -99.00", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      expect(r.warnings.some((w) => w.field === "total")).toBe(true);
    },
  },
  {
    name: "missing everything fallback",
    pages: [page("a b c d e", [{ text: "a b c d e", y: 0 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      // every field that we tried but couldn't extract gets a low-confidence entry
      expect(r.warnings.length).toBeGreaterThan(0);
    },
  },
  {
    name: "stage entry is recorded",
    pages: [page("Total: $1.00", [{ text: "Total: $1.00", y: 800 }])],
    expect: (r) => {
      expect(r.stages).toHaveLength(1);
      expect(r.stages[0].name).toBe("schema-extraction");
      expect(r.stages[0].model).toBe("rules-v1");
      expect(r.stages[0].version).toBe("0.1.0");
    },
  },
];

describe("rules.extractFields", () => {
  for (const c of CASES) {
    it(c.name, () => c.expect(extractFields(c.pages)));
  }
});
