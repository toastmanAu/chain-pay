// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapSuryaPages } from "./surya-mapper";
import { SuryaContentError } from "./types";
import type { PageOcr } from "./types";

function fixture(name: string): PageOcr[] {
  const path = join(__dirname, "__fixtures__", "surya", name);
  return [{ pageIndex: 0, text: readFileSync(path, "utf8"), lines: [] }];
}

describe("mapSuryaPages — fixture cases", () => {
  it("clean AUD invoice — fills total, currency, vendor, line items", () => {
    const r = mapSuryaPages(fixture("clean-aud-invoice.html"));
    expect(r.body.total).toBeCloseTo(1358.02);
    expect(r.body.currency).toBe("AUD");
    expect(r.body.payee?.display_name).toContain("Acme");
    expect(r.body.line_items).toBeDefined();
    expect(r.body.line_items!.length).toBeGreaterThanOrEqual(1);
  });

  it("Nervos busy invoice — fills $1,000.00 total and full 95-char CKB address", () => {
    const r = mapSuryaPages(fixture("nervos-busy.html"));
    expect(r.body.total).toBe(1000);
    expect(r.body.currency).toBe("USD");
    expect(r.body.payee?.display_name).toMatch(/3RD PARTY INVOICE|Nervos Foundation|Sheet1/);
    expect(r.body.payment_details?.ckb_address).toMatch(/^ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2j8u6k5yemt00gkf4q4dszr2uht6ct2fqj32hc2$/);
  });

  it("POS device photo — fills invoice number, item name, totals", () => {
    const r = mapSuryaPages(fixture("pos-photo.html"));
    expect(r.body.invoice_number).toBe("1766122468");
    expect(r.body.total).toBeCloseTo(22076.42);
    expect(r.body.currency).toBe("USD");
    // payee heuristic should not pick "Image" labelled UI icons
    expect(r.body.payee?.display_name).not.toMatch(/^Image$/);
  });
});

describe("mapSuryaPages — edge cases", () => {
  it("zero-block HTML throws SuryaContentError", () => {
    expect(() => mapSuryaPages([{ pageIndex: 0, text: "<p>no bboxes</p>", lines: [] }]))
      .toThrow(SuryaContentError);
  });

  it("EU comma-decimal in total block produces warning, no total", () => {
    const html = `<div data-bbox="0 0 100 20" data-label="Text"><p>Total: € 250,00</p></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.total).toBeUndefined();
    expect(r.warnings.some((w) => w.field === "total" && /european|decimal|manual review/i.test(w.message))).toBe(true);
  });

  it("table with missing headers — line items emitted at lower confidence with warning", () => {
    const html = `<div data-bbox="0 0 100 100" data-label="Table"><table><tbody><tr><td>x</td><td>1</td><td>1.00</td><td>1.00</td></tr></tbody></table></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.line_items).toBeDefined();
    expect(r.field_confidences.line_items).toBeLessThan(0.85);
    expect(r.warnings.some((w) => w.field === "line_items")).toBe(true);
  });

  it("tax line — fills tax_total from /tax|gst|vat/i block", () => {
    const html = `<div data-bbox="0 0 100 20" data-label="Text"><p>GST 10%: $99.05</p></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.tax_total).toBeCloseTo(99.05);
  });

  it("tax line with parenthesised rate — captures amount, not rate", () => {
    const html = `<div data-bbox="0 0 100 20" data-label="Text"><p>GST (10%): $99.05</p></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.tax_total).toBeCloseTo(99.05);
  });

  it("subtotal line — fills subtotal field", () => {
    const html = `<div data-bbox="0 0 100 20" data-label="Text"><p>Subtotal: $1,234.56</p></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.subtotal).toBeCloseTo(1234.56);
  });

  it("table with 'Unit Total' header (collision) — line items at lower confidence", () => {
    const html = `<div data-bbox="0 0 100 100" data-label="Table"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit Total</th></tr></thead><tbody><tr><td>Widget</td><td>2</td><td>10.00</td></tr></tbody></table></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.body.line_items).toBeDefined();
    expect(r.field_confidences.line_items).toBeLessThan(0.85);
  });

  it("records stage entry with surya-mapper-v1 model name", () => {
    const html = `<div data-bbox="0 0 100 20" data-label="Text"><p>x</p></div>`;
    const r = mapSuryaPages([{ pageIndex: 0, text: html, lines: [] }]);
    expect(r.stages).toHaveLength(1);
    expect(r.stages[0]!.name).toBe("schema-extraction");
    expect(r.stages[0]!.model).toBe("surya-mapper-v1");
    expect(r.stages[0]!.version).toBe("0.1.0");
  });
});
