import type { Invoice } from "@chain-pay/shared";
import type { ExtractionResult, MapperFn, PageOcr } from "./types";
import { SuryaContentError } from "./types";
import { parseBlocks, parseTable, type Block } from "./surya-html";
import {
  ACCOUNT_RE,
  BSB_RE,
  CKB_RE,
  CURRENCY_TOKENS,
  DUE_RE,
  EVM_RE,
  INVOICE_NUMBER_RE,
  ISSUED_RE,
  TOTAL_LABEL_RE,
  parseCurrency,
  parseDate,
} from "./regex-shared";

const STAGE_NAME = "schema-extraction" as const;
const STAGE_MODEL = "surya-mapper-v1" as const;
const STAGE_VERSION = "0.1.0" as const;

const SUBTOTAL_RE = /subtotal\s*[:\-]?\s*[\$£€]?\s*([\d,]+(?:\.\d+)?)/i;
const TAX_RE = /^(?:tax|gst|vat)\s*(?:\d+%?)?\s*[:\-]?\s*\(?\s*[\$£€]?\s*([\d,]+(?:\.\d+)?)/i;

type Mut = {
  body: Partial<Invoice["invoice"]>;
  conf: Record<string, number>;
  warn: NonNullable<Invoice["extraction"]["warnings"]>;
};

function allText(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n");
}

function fillCurrency(blocks: Block[], m: Mut): void {
  const text = allText(blocks);
  for (const [re, code] of CURRENCY_TOKENS) {
    if (re.test(text)) {
      m.body.currency = code;
      m.conf.currency = 0.9;
      return;
    }
  }
}

function fillTotal(blocks: Block[], m: Mut): void {
  const text = allText(blocks);
  const match = text.match(TOTAL_LABEL_RE);
  if (!match) {
    m.warn.push({ field: "total", severity: "info", message: "No total found" });
    return;
  }
  const parsed = parseCurrency(match[1]!);
  if (parsed.total !== undefined) {
    m.body.total = parsed.total;
    m.conf.total = 0.9;
  } else if (parsed.warn) {
    m.warn.push({ field: "total", severity: "warn", message: parsed.warn });
  }
}

function fillInvoiceNumberAndDates(blocks: Block[], m: Mut): void {
  const text = allText(blocks);
  const inv = text.match(INVOICE_NUMBER_RE);
  if (inv) {
    m.body.invoice_number = inv[1]!;
    m.conf.invoice_number = 0.85;
  }
  const issued = text.match(ISSUED_RE);
  if (issued) {
    const d = parseDate(issued[1]!);
    if (d) {
      m.body.issue_date = d;
      m.conf.issue_date = 0.85;
    }
  }
  const due = text.match(DUE_RE);
  if (due) {
    const d = parseDate(due[1]!);
    if (d) {
      m.body.due_date = d;
      m.conf.due_date = 0.85;
    }
  }
}

function fillPayeeDisplayName(blocks: Block[], m: Mut): void {
  const onPage0 = blocks.filter((b) => b.pageIndex === 0);
  const sectionHeader = onPage0.find((b) => b.label === "Section-Header" && b.text.length > 1);
  if (sectionHeader) {
    m.body.payee = { kind: "unknown", display_name: sectionHeader.text };
    m.conf.payee_display_name = 0.85;
    return;
  }
  // Fallback: largest text block in top 25% of page 0
  if (onPage0.length === 0) return;
  const ys = onPage0.map((b) => b.bbox.y0);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cutoff = minY + (maxY - minY) * 0.25;
  const candidates = onPage0.filter(
    (b) => b.bbox.y0 <= cutoff && b.text.length > 1 && b.label !== "Image" && b.label !== "Page-Header",
  );
  if (candidates.length === 0) return;
  const tallest = candidates.reduce((a, b) =>
    a.bbox.y1 - a.bbox.y0 >= b.bbox.y1 - b.bbox.y0 ? a : b,
  );
  m.body.payee = { kind: "unknown", display_name: tallest.text };
  m.conf.payee_display_name = 0.55;
}

function fillPaymentDetails(blocks: Block[], m: Mut): void {
  const text = allText(blocks);
  const bsb = text.match(BSB_RE);
  const acct = text.match(ACCOUNT_RE);
  if (bsb ?? acct) {
    m.body.payment_details = {
      ...(m.body.payment_details ?? {}),
      bank: {
        ...(bsb ? { bsb: bsb[1]! } : {}),
        ...(acct ? { account_number: acct[1]! } : {}),
      },
    };
    if (bsb) m.conf.bsb = 0.75;
    if (acct) m.conf.account_number = 0.9;
  }
  const ckb = text.match(CKB_RE);
  if (ckb) {
    m.body.payment_details = { ...(m.body.payment_details ?? {}), ckb_address: ckb[1]! };
    m.conf.ckb_address = 0.99;
  }
  const evm = text.match(EVM_RE);
  if (evm) {
    m.body.payment_details = { ...(m.body.payment_details ?? {}), evm_address: evm[1]!.toLowerCase() };
    m.conf.evm_address = 0.99;
  }
}

function fillSubtotal(blocks: Block[], m: Mut): void {
  for (const b of blocks) {
    const match = b.text.match(SUBTOTAL_RE);
    if (match) {
      const parsed = parseCurrency(match[1]!);
      if (parsed.total !== undefined) {
        m.body.subtotal = parsed.total;
        m.conf.subtotal = 0.85;
        return;
      }
    }
  }
}

function fillTaxTotal(blocks: Block[], m: Mut): void {
  for (const b of blocks) {
    const match = b.text.match(TAX_RE);
    if (match) {
      const parsed = parseCurrency(match[1]!);
      if (parsed.total !== undefined) {
        m.body.tax_total = parsed.total;
        m.conf.tax_total = 0.85;
        return;
      }
    }
  }
}

const HEADER_DESC = /desc/i;
const HEADER_QTY = /qty|quantity/i;
const HEADER_UNIT = /unit/i;
const HEADER_TOTAL = /total|amount/i;

function fillLineItems(blocks: Block[], m: Mut): void {
  const tableBlocks = blocks.filter(
    (b) => b.label === "Table" || /<table\b/i.test(b.html),
  );
  if (tableBlocks.length === 0) return;

  const lines: NonNullable<Invoice["invoice"]["line_items"]> = [];
  let allHeadersFound = true;

  for (const b of tableBlocks) {
    const t = parseTable(b.html);
    if (t.rows.length === 0) continue;

    const descIdx = t.headers.findIndex((h) => HEADER_DESC.test(h));
    const qtyIdx = t.headers.findIndex((h) => HEADER_QTY.test(h));
    const unitIdx = t.headers.findIndex((h) => HEADER_UNIT.test(h));
    const totalIdx = t.headers.findIndex((h) => HEADER_TOTAL.test(h));

    if (descIdx === -1 || qtyIdx === -1 || unitIdx === -1 || totalIdx === -1) {
      allHeadersFound = false;
    }

    for (const row of t.rows) {
      const description = (descIdx >= 0 ? row[descIdx] : row[0]) ?? "";
      const qtyRaw = qtyIdx >= 0 ? row[qtyIdx] : undefined;
      const unitRaw = unitIdx >= 0 ? row[unitIdx] : undefined;
      const totalRaw = totalIdx >= 0 ? row[totalIdx] : row[row.length - 1];
      const qty = qtyRaw !== undefined ? Number(qtyRaw.replace(/,/g, "")) : undefined;
      const unitPrice = unitRaw !== undefined ? parseCurrency(unitRaw).total : undefined;
      const lineTotal = parseCurrency(totalRaw ?? "0").total ?? 0;
      lines.push({
        description,
        quantity: qty !== undefined && Number.isFinite(qty) ? qty : null,
        unit_price: unitPrice ?? null,
        line_total: lineTotal,
      });
    }
  }

  if (lines.length === 0) return;
  m.body.line_items = lines;
  m.conf.line_items = allHeadersFound ? 0.85 : 0.6;
  if (!allHeadersFound) {
    m.warn.push({
      field: "line_items",
      severity: "info",
      message: "Some table headers couldn't be identified — please check column mapping",
    });
  }
}

export const mapSuryaPages: MapperFn = (pages: PageOcr[]) => {
  const t0 = performance.now();
  const blocks: Block[] = pages.flatMap((p, i) => parseBlocks(p.text, i));
  if (blocks.length === 0) {
    throw new SuryaContentError("Surya returned no blocks — page may be blank");
  }

  const m: Mut = { body: {}, conf: {}, warn: [] };
  fillPayeeDisplayName(blocks, m);
  fillCurrency(blocks, m);
  fillTotal(blocks, m);
  fillInvoiceNumberAndDates(blocks, m);
  fillPaymentDetails(blocks, m);
  fillSubtotal(blocks, m);
  fillTaxTotal(blocks, m);
  fillLineItems(blocks, m);

  return {
    stages: [
      {
        name: STAGE_NAME,
        model: STAGE_MODEL,
        version: STAGE_VERSION,
        elapsed_ms: Math.max(0, Math.round(performance.now() - t0)),
      },
    ],
    body: m.body,
    field_confidences: m.conf,
    warnings: m.warn,
  };
};
