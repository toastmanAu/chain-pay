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
} from "@chain-pay/shared";

export interface MobileExtractionWarning {
  field: string;
  severity: "info" | "warn" | "error";
  message: string;
}

export interface MobileExtraction {
  body: Record<string, unknown>;
  field_confidences: Record<string, number>;
  warnings: MobileExtractionWarning[];
}

/**
 * Maps raw OCR text (e.g. from ML Kit / Vision) into a partial invoice body
 * using the shared invoice regex primitives. Mirrors the desktop
 * `extractFields` shape but operates on a single flat string instead of
 * `PageOcr[]`, which is what mobile native OCR produces.
 */
export function ocrToExtraction(text: string): MobileExtraction {
  const body: Record<string, unknown> = {};
  const field_confidences: Record<string, number> = {};
  const warnings: MobileExtractionWarning[] = [];

  // currency
  for (const [re, code] of CURRENCY_TOKENS) {
    if (re.test(text)) {
      body.currency = code;
      field_confidences.currency = 0.9;
      break;
    }
  }

  // total
  const totalMatch = text.match(TOTAL_LABEL_RE);
  if (totalMatch && totalMatch[1]) {
    const parsed = parseCurrency(totalMatch[1]);
    if (parsed.total !== undefined) {
      body.total = parsed.total;
      field_confidences.total = 0.9;
    } else if (parsed.warn) {
      warnings.push({ field: "total", severity: "warn", message: parsed.warn });
    }
  }

  // invoice number
  const invNum = text.match(INVOICE_NUMBER_RE);
  if (invNum && invNum[1]) {
    body.invoice_number = invNum[1];
    field_confidences.invoice_number = 0.85;
  }

  // dates
  const issued = text.match(ISSUED_RE);
  if (issued && issued[1]) {
    const d = parseDate(issued[1]);
    if (d) {
      body.issue_date = d;
      field_confidences.issue_date = 0.85;
    }
  }
  const due = text.match(DUE_RE);
  if (due && due[1]) {
    const d = parseDate(due[1]);
    if (d) {
      body.due_date = d;
      field_confidences.due_date = 0.85;
    }
  }

  // bank — BSB + account number
  const bsb = text.match(BSB_RE);
  const acct = text.match(ACCOUNT_RE);
  if (bsb || acct) {
    const bank: Record<string, string> = {};
    if (bsb && bsb[1]) {
      bank.bsb = bsb[1];
      field_confidences["bank.bsb"] = 0.85;
    }
    if (acct && acct[1]) {
      bank.account_number = acct[1];
      field_confidences["bank.account_number"] = 0.8;
    }
    body.bank = bank;
  }

  // crypto addresses
  const ckb = text.match(CKB_RE);
  if (ckb && ckb[1]) {
    body.ckb_address = ckb[1];
    field_confidences.ckb_address = 0.9;
  }
  const evm = text.match(EVM_RE);
  if (evm && evm[1]) {
    body.evm_address = evm[1];
    field_confidences.evm_address = 0.9;
  }

  return { body, field_confidences, warnings };
}
