import {
  type Invoice,
  CURRENCY_TOKENS,
  INVOICE_NUMBER_RE,
  TOTAL_LABEL_RE,
  ISSUED_RE,
  DUE_RE,
  BSB_RE,
  ACCOUNT_RE,
  CKB_RE,
  EVM_RE,
  parseCurrency,
  parseDate,
} from "@chain-pay/shared";
import type { ExtractionResult, PageOcr } from "./types";

const STAGE_NAME = "schema-extraction" as const;
const STAGE_MODEL = "rules-v1" as const;
const STAGE_VERSION = "0.1.0" as const;

export function extractFields(pages: PageOcr[]): ExtractionResult {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const body: Partial<Invoice["invoice"]> = {};
  const field_confidences: Record<string, number> = {};
  const warnings: NonNullable<Invoice["extraction"]["warnings"]> = [];
  const allText = pages.map((p) => p.text).join("\n");

  // currency
  for (const [re, code] of CURRENCY_TOKENS) {
    if (re.test(allText)) {
      body.currency = code;
      field_confidences.currency = 0.9;
      break;
    }
  }

  // total
  const totalMatch = allText.match(TOTAL_LABEL_RE);
  if (totalMatch) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = parseCurrency(totalMatch[1]!);
    if (parsed.total !== undefined) {
      body.total = parsed.total;
      field_confidences.total = 0.9;
    } else if (parsed.warn) {
      warnings.push({ field: "total", severity: "warn", message: parsed.warn });
    }
  } else {
    warnings.push({ field: "total", severity: "info", message: "No total found" });
  }

  // invoice number
  const invNum = allText.match(INVOICE_NUMBER_RE);
  if (invNum) {
    body.invoice_number = invNum[1];
    field_confidences.invoice_number = 0.85;
  } else {
    warnings.push({ field: "invoice_number", severity: "info", message: "No invoice number found" });
  }

  // dates
  const issued = allText.match(ISSUED_RE);
  if (issued) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const d = parseDate(issued[1]!);
    if (d) {
      body.issue_date = d;
      field_confidences.issue_date = 0.85;
    }
  }
  const due = allText.match(DUE_RE);
  if (due) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const d = parseDate(due[1]!);
    if (d) {
      body.due_date = d;
      field_confidences.due_date = 0.85;
    }
  }

  // payee display_name — largest line in top 25% of page 1
  const page1 = pages[0];
  if (page1?.lines.length) {
    const ys = page1.lines.map((l) => l.bbox.y0);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const topQuarterCutoff = minY + (maxY - minY) * 0.25;
    const candidates = page1.lines.filter((l) => l.bbox.y0 <= topQuarterCutoff && l.text.trim().length > 1);
    if (candidates.length) {
      const tallest = candidates.reduce((a, b) =>
        (a.bbox.y1 - a.bbox.y0) >= (b.bbox.y1 - b.bbox.y0) ? a : b,
      );
      body.payee = { kind: "unknown", display_name: tallest.text.trim() };
      field_confidences.payee_display_name = 0.55;
    }
  }

  // bank details
  const bsb = allText.match(BSB_RE);
  const acct = allText.match(ACCOUNT_RE);
  if (bsb || acct) {
    body.payment_details = {
      ...(body.payment_details ?? {}),
      bank: {
        ...(bsb ? { bsb: bsb[1] } : {}),
        ...(acct ? { account_number: acct[1] } : {}),
      },
    };
    if (bsb) field_confidences.bsb = 0.75;
    if (acct) field_confidences.account_number = 0.9;
  }

  // ckb / evm
  const ckb = allText.match(CKB_RE);
  if (ckb) {
    body.payment_details = { ...(body.payment_details ?? {}), ckb_address: ckb[1] };
    field_confidences.ckb_address = 0.99;
  }
  const evm = allText.match(EVM_RE);
  if (evm) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    body.payment_details = { ...(body.payment_details ?? {}), evm_address: evm[1]!.toLowerCase() };
    field_confidences.evm_address = 0.99;
  }

  const elapsed_ms = Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));

  return {
    stages: [{ name: STAGE_NAME, model: STAGE_MODEL, version: STAGE_VERSION, elapsed_ms }],
    body,
    field_confidences,
    warnings,
  };
}
