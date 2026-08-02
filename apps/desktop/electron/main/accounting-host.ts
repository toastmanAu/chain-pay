import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dialog, ipcMain } from "electron";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
  recordName: string;
  recordIdempotent: boolean;
}

export type ComplianceFormat = "csv" | "pdf";

export interface ComplianceFilters {
  fromDate?: string;
  toDate?: string;
  chain?: "ckb:mainnet" | "ckb:testnet" | "evm:11155111";
}

export interface ComplianceSaveResult {
  canceled: boolean;
  filePath?: string;
  rowCount?: number;
  sha256?: string;
}

interface CompliancePayload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  rowCount: number;
  sha256: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured (Frappe accounting bridge)`);
  return v;
}

/**
 * POST a confirmed domain payment record to the whitelisted Frappe endpoint.
 * Credentials live only here in the main process. Throws on any failure so the
 * renderer can transition the payment to post_failed. GL accounts are not part
 * of this contract; Frappe owns account selection and Journal Entry derivation.
 */
export async function postJournalToFrappe(
  record: unknown,
): Promise<PostJournalResult> {
  const base = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const res = await fetch(`${base}/api/method/crypto_payroll.api.post_confirmed_payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${key}:${secret}`,
    },
    // Slice B gotcha #1: Frappe routes by Host header. We do NOT set Host
    // manually (fetch/undici treats it as a forbidden header). Instead FRAPPE_URL
    // MUST be the site host (http://chainpay.localhost:PORT), so fetch derives the
    // correct Host automatically. chainpay.localhost resolves to 127.0.0.1 on the
    // host where Electron main runs.
    body: JSON.stringify(
      { record },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    ),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Frappe post_confirmed_payment failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  const body = (await res.json()) as {
    message?: {
      je_name?: unknown;
      idempotent?: unknown;
      record_name?: unknown;
      record_idempotent?: unknown;
    };
  };
  if (
    typeof body.message?.je_name !== "string" ||
    body.message.je_name.length === 0 ||
    typeof body.message.idempotent !== "boolean" ||
    typeof body.message.record_name !== "string" ||
    body.message.record_name.length === 0 ||
    typeof body.message.record_idempotent !== "boolean"
  ) {
    throw new Error("Frappe post_confirmed_payment returned an invalid response");
  }
  return {
    jeName: body.message.je_name,
    idempotent: body.message.idempotent,
    recordName: body.message.record_name,
    recordIdempotent: body.message.record_idempotent,
  };
}

/** Fetch a server-assembled report. The renderer supplies filters, never rows. */
export async function fetchComplianceExport(
  filters: ComplianceFilters,
  format: ComplianceFormat,
): Promise<CompliancePayload> {
  const normalised = normaliseComplianceRequest(filters, format);
  const base = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const res = await fetch(`${base}/api/method/crypto_payroll.api.export_compliance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${key}:${secret}`,
    },
    body: JSON.stringify(normalised),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Frappe compliance export failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { message?: Record<string, unknown> };
  return parseCompliancePayload(body.message, format);
}

export async function saveComplianceExport(
  filters: ComplianceFilters,
  format: ComplianceFormat,
  dependencies?: {
    choosePath: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>;
    write: typeof writeFile;
  },
): Promise<ComplianceSaveResult> {
  const payload = await fetchComplianceExport(filters, format);
  const choosePath = dependencies?.choosePath ?? ((options) => dialog.showSaveDialog(options));
  const write = dependencies?.write ?? writeFile;
  const choice = await choosePath({
    title: "Save ChainPay compliance export",
    defaultPath: payload.filename,
    filters: format === "csv"
      ? [{ name: "CSV spreadsheet", extensions: ["csv"] }]
      : [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (choice.canceled || !choice.filePath) return { canceled: true };
  await write(choice.filePath, payload.bytes, { mode: 0o600 });
  return {
    canceled: false,
    filePath: choice.filePath,
    rowCount: payload.rowCount,
    sha256: payload.sha256,
  };
}

function normaliseComplianceRequest(filters: ComplianceFilters, format: ComplianceFormat) {
  if (format !== "csv" && format !== "pdf") throw new Error("Compliance format must be csv or pdf");
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new Error("Compliance filters must be an object");
  }
  const unknown = Object.keys(filters).filter((key) => !["fromDate", "toDate", "chain"].includes(key));
  if (unknown.length) throw new Error(`Unsupported compliance filter: ${unknown[0]}`);
  const date = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} must be YYYY-MM-DD`);
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`${name} must be a real calendar date`);
    }
    return value;
  };
  const from = date(filters.fromDate, "fromDate");
  const to = date(filters.toDate, "toDate");
  if (from && to && from > to) throw new Error("fromDate cannot be after toDate");
  if (filters.chain && !["ckb:mainnet", "ckb:testnet", "evm:11155111"].includes(filters.chain)) {
    throw new Error("Unsupported compliance chain");
  }
  return {
    filters: {
      ...(from ? { from_date: from } : {}),
      ...(to ? { to_date: to } : {}),
      ...(filters.chain ? { chain: filters.chain } : {}),
    },
    format,
  };
}

function parseCompliancePayload(raw: Record<string, unknown> | undefined, format: ComplianceFormat): CompliancePayload {
  const expectedMime = format === "csv" ? "text/csv;charset=utf-8" : "application/pdf";
  const extension = format === "csv" ? "csv" : "pdf";
  if (
    !raw || typeof raw.filename !== "string" ||
    !new RegExp(`^chainpay-compliance-[A-Za-z0-9.-]+\\.${extension}$`).test(raw.filename) ||
    raw.mime_type !== expectedMime || typeof raw.bytes_base64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.bytes_base64) ||
    typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256) ||
    typeof raw.row_count !== "number" || !Number.isSafeInteger(raw.row_count) || raw.row_count <= 0
  ) {
    throw new Error("Frappe compliance export returned an invalid response");
  }
  const bytes = Buffer.from(raw.bytes_base64, "base64");
  if (bytes.toString("base64") !== raw.bytes_base64) {
    throw new Error("Frappe compliance export returned invalid base64 data");
  }
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
    throw new Error("Frappe compliance export returned an invalid file size");
  }
  if (format === "pdf" && !bytes.subarray(0, 8).equals(Buffer.from("%PDF-1.4"))) {
    throw new Error("Frappe compliance export returned invalid PDF bytes");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== raw.sha256) throw new Error("Frappe compliance export integrity check failed");
  return {
    filename: raw.filename,
    mimeType: expectedMime,
    bytes,
    rowCount: raw.row_count,
    sha256: digest,
  };
}

export function registerAccountingIpc(): void {
  ipcMain.handle("accounting:postJournal", async (_evt, record: unknown) => {
    return postJournalToFrappe(record);
  });
  ipcMain.handle(
    "accounting:exportCompliance",
    async (_evt, filters: ComplianceFilters, format: ComplianceFormat) =>
      saveComplianceExport(filters, format),
  );
}
