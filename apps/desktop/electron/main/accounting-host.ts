import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dialog, ipcMain } from "electron";
import { z } from "zod";

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
  chain?: "ckb:mainnet" | "ckb:testnet" | "evm:11155111" | "sol:devnet" | "sol:mainnet" | "btc:testnet" | "btc:mainnet";
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

const canonicalUint = z.union([z.bigint().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)]);
const hexDigest = z.string().regex(/^[0-9a-f]{64}$/);
const paymentLineSchema = z.object({
  payeeId: z.string().min(1).max(140),
  fiat: z.object({ currency: z.literal("USD"), minor: canonicalUint }).strict(),
  crypto: z.object({ asset: z.string().min(1).max(12), value: canonicalUint, decimals: z.number().int().min(0).max(30) }).strict(),
}).strict();
const evmSchema = z.object({
  safeAddress: z.string(), safeTxHash: z.string(), outerTxHash: z.string(), executorAddress: z.string(),
  recipientAddress: z.string(), confirmedBlockNumber: z.string(), gasUsed: z.string(),
  effectiveGasPriceWei: z.string(), gasFeeWei: z.string(), gasPayer: z.literal("executor"),
}).strict();
const solanaSchema = z.object({
  reviewDigest: z.string(), sourceAddress: z.string(), recipientAddress: z.string(), feePayerAddress: z.string(),
  nonceAccount: z.string(), nonceAuthority: z.string(), durableNonce: z.string(), finalizedSlot: z.string(),
  amountLamports: z.string(), feeLamports: z.string(), feePayerPolicy: z.literal("transaction_fee_payer"),
  messageBase64: z.string().max(4096),
}).strict();
const bitcoinSchema = z.object({
  reviewDigest: hexDigest, wtxid: hexDigest, rawTransactionHash: hexDigest, blockHeight: canonicalUint,
  blockHash: hexDigest, confirmations: canonicalUint, inputValueSats: canonicalUint, outputValueSats: canonicalUint,
  feeSats: canonicalUint, feeRateSatsPerVbyte: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/), feePayerPolicy: z.literal("transaction_inputs"),
  outputs: z.array(z.object({ vout: canonicalUint, destination: z.string().min(1).max(100), valueSats: canonicalUint }).strict()).min(1).max(500),
}).strict();
const confirmedRecordSchema = z.object({
  batchId: z.string().min(1).max(140), sourceType: z.enum(["send", "payroll"]), label: z.string().min(1).max(140),
  chain: z.enum(["ckb:mainnet", "ckb:testnet", "evm:11155111", "sol:devnet", "sol:mainnet", "btc:testnet", "btc:mainnet"]),
  txHash: z.string().min(1).max(128), confirmedAt: z.string().datetime({ offset: true }),
  lines: z.array(paymentLineSchema).min(1).max(500), evm: evmSchema.optional(), solana: solanaSchema.optional(), bitcoin: bitcoinSchema.optional(),
}).strict().superRefine((value, context) => {
  const family = value.chain.split(":")[0];
  if (
    (family === "evm") !== Boolean(value.evm) ||
    (family === "sol") !== Boolean(value.solana) ||
    (family === "btc") !== Boolean(value.bitcoin)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-chain metadata is not allowed" });
  }
  const expected = family === "btc" ? ["BTC", 8] : family === "sol" ? ["SOL", 9] : family === "evm" ? ["ETH", 18] : ["CKB", 8];
  if (value.lines.some((line) => line.crypto.asset !== expected[0] || line.crypto.decimals !== expected[1])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "chain asset metadata is invalid" });
  }
  if (value.bitcoin) {
    const amount = (input: bigint | string) => BigInt(input);
    const input = amount(value.bitcoin.inputValueSats), output = amount(value.bitcoin.outputValueSats), fee = amount(value.bitcoin.feeSats);
    const max = 2_100_000_000_000_000n;
    const outputsOrdered = value.bitcoin.outputs.every((item, index, items) => index === 0 || amount(items[index - 1]!.vout) < amount(item.vout));
    const outputsMatch = value.bitcoin.outputs.length === value.lines.length && value.bitcoin.outputs.every((item, index) => amount(item.valueSats) === amount(value.lines[index]!.crypto.value));
    if (amount(value.bitcoin.confirmations) < 6n || input <= 0n || output <= 0n || fee <= 0n || input > max || output > max || fee > max || input !== output + fee || !outputsOrdered || !outputsMatch) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Bitcoin finalized evidence is inconsistent" });
    }
  }
});

function accountingBaseUrl(): string {
  const raw = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("FRAPPE_URL must be a valid URL"); }
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("FRAPPE_URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  return raw;
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
  const parsedRecord = confirmedRecordSchema.safeParse(record);
  if (!parsedRecord.success) throw new Error("Confirmed payment record failed strict validation");
  const base = accountingBaseUrl();
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const bodyText = JSON.stringify(
    { record: parsedRecord.data },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  if (Buffer.byteLength(bodyText) > 1024 * 1024) throw new Error("Confirmed payment record is too large");
  let res: Response;
  try {
    res = await fetch(`${base}/api/method/crypto_payroll.api.post_confirmed_payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${key}:${secret}`,
      },
      signal: AbortSignal.timeout(20_000),
    // Slice B gotcha #1: Frappe routes by Host header. We do NOT set Host
    // manually (fetch/undici treats it as a forbidden header). Instead FRAPPE_URL
    // MUST be the site host (http://chainpay.localhost:PORT), so fetch derives the
    // correct Host automatically. chainpay.localhost resolves to 127.0.0.1 on the
    // host where Electron main runs.
      body: bodyText,
    });
  } catch {
    throw new Error("Frappe accounting request failed");
  }
  if (!res.ok) {
    throw new Error(`Frappe accounting service rejected the request (${res.status})`);
  }
  const body = await boundedJson(res) as {
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
  const base = accountingBaseUrl();
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  let res: Response;
  try {
    res = await fetch(`${base}/api/method/crypto_payroll.api.export_compliance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${key}:${secret}`,
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify(normalised),
    });
  } catch {
    throw new Error("Frappe compliance request failed");
  }
  if (!res.ok) {
    throw new Error(`Frappe compliance service rejected the request (${res.status})`);
  }
  const body = await boundedJson(res, 25 * 1024 * 1024 + 1024 * 1024) as { message?: Record<string, unknown> };
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
  if (filters.chain && !["ckb:mainnet", "ckb:testnet", "evm:11155111", "sol:devnet", "sol:mainnet", "btc:testnet", "btc:mainnet"].includes(filters.chain)) {
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

async function boundedJson(response: Response, maximum = 1024 * 1024): Promise<unknown> {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Frappe response is too large");
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Frappe response is too large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Frappe returned invalid JSON"); }
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
