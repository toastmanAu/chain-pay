export const CURRENCY_TOKENS: Array<[RegExp, string]> = [
  [/\bAUD\b/i, "AUD"],
  [/\bUSD\b/i, "USD"],
  [/\bEUR\b/i, "EUR"],
  [/\bGBP\b/i, "GBP"],
  [/€/, "EUR"],
  [/£/, "GBP"],
  [/\$/, "USD"],
];

export const INVOICE_NUMBER_RE = /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9\-_/]+)/i;
// (?:^|[^a-z]) — with /i flag, [^a-z] becomes [^a-zA-Z], blocking "Subtotal"/"SUBTOTAL".
export const TOTAL_LABEL_RE = /(?:^|[^a-z])total\s*[:\-]?\s*(?:[A-Z]{3}\s*)?([\$£€]?\s*-?[\d,]+(?:\.\d+)?)/i;
export const ISO_DATE_OR_DMY = /(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/;
export const ISSUED_RE = new RegExp("(?:issued|issue\\s*date)\\s*[:\\-]?\\s*" + ISO_DATE_OR_DMY.source, "i");
export const DUE_RE = new RegExp("due\\s*(?:date)?\\s*[:\\-]?\\s*" + ISO_DATE_OR_DMY.source, "i");
export const BSB_RE = /\b(\d{3}-\d{3})\b/;
export const ACCOUNT_RE = /account\s*[:\-]?\s*(\d{6,10})/i;
export const CKB_RE = /\b(ck[bt]1[a-z0-9]{20,})/i;
export const EVM_RE = /\b(0x[0-9a-f]{40})\b/i;

export function parseCurrency(s: string): { total?: number; warn?: string } {
  const stripped = s.replace(/[\$£€\s]/g, "");
  if (/,\d{2}$/.test(stripped) && !/\.\d/.test(stripped.slice(stripped.lastIndexOf(",")))) {
    return { warn: "Possible European decimal format — manual review needed" };
  }
  const cleaned = stripped.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { warn: "Total looked invalid" };
  if (n < 0) return { warn: "Total looked invalid" };
  return { total: n };
}

// Assumes dd/mm/yyyy (Australian/European convention). US mm/dd documents will be mis-parsed.
export function parseDate(raw: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return undefined;
  const dd = m[1]!.padStart(2, "0");
  const mm = m[2]!.padStart(2, "0");
  let yyyy = m[3]!;
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return undefined;
  return `${yyyy}-${mm}-${dd}`;
}
