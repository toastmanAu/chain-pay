import bs58 from "bs58";
import JSONBigFactory from "json-bigint";
import { z } from "zod";
import type {
  SolanaChain,
  SolanaScanResponse,
  SolanaTransactionState,
  SolanaTransactionStatusResponse,
  SolanaWatchTransaction,
} from "@chain-pay/shared";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const HISTORY_PAGE_SIZE = 25;
const MAX_HISTORY_PAGES = 4;
const U64_MAX = 18_446_744_073_709_551_615n;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const JSONBig = JSONBigFactory({
  strict: true,
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});

const exactUnsignedSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(DECIMAL),
]).transform((value, context) => {
  const text = String(value);
  try {
    if (BigInt(text) > U64_MAX) throw new Error("u64 overflow");
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid u64" });
    return z.NEVER;
  }
  return text;
});

const contextSchema = z.object({ slot: exactUnsignedSchema }).passthrough();
const commitmentSchema = z.enum(["processed", "confirmed", "finalized"]);
const signatureTextSchema = z.string().min(80).max(90).refine(isCanonicalSignature);
const publicKeySchema = z.string().min(32).max(44).refine(isCanonicalSolanaAddress);
const blockhashSchema = z.string().min(32).max(44).refine(isCanonicalBlockhash);

const latestBlockhashSchema = z.object({
  context: contextSchema,
  value: z.object({
    blockhash: blockhashSchema,
    lastValidBlockHeight: exactUnsignedSchema,
  }).strict(),
}).strict();

const balanceSchema = z.object({
  context: contextSchema,
  value: exactUnsignedSchema,
}).strict();

const signatureInfoSchema = z.object({
  signature: signatureTextSchema,
  slot: exactUnsignedSchema,
  err: z.unknown().nullable(),
  memo: z.string().nullable(),
  blockTime: z.number().int().safe().nullable(),
  confirmationStatus: commitmentSchema.nullable(),
}).strict();

const transactionSchema = z.object({
  slot: exactUnsignedSchema,
  blockTime: z.number().int().safe().nullable(),
  version: z.union([z.literal("legacy"), z.number().int().nonnegative().safe()]),
  meta: z.object({
    err: z.unknown().nullable(),
    fee: exactUnsignedSchema,
    preBalances: z.array(exactUnsignedSchema),
    postBalances: z.array(exactUnsignedSchema),
    loadedAddresses: z.object({
      writable: z.array(publicKeySchema),
      readonly: z.array(publicKeySchema),
    }).strict().optional(),
  }).passthrough().nullable(),
  transaction: z.object({
    signatures: z.array(signatureTextSchema).min(1),
    message: z.object({ accountKeys: z.array(publicKeySchema).min(1) }).passthrough(),
  }).passthrough(),
}).passthrough().nullable();

const statusValueSchema = z.object({
  slot: exactUnsignedSchema,
  confirmations: z.number().int().nonnegative().safe().nullable(),
  err: z.unknown().nullable(),
  confirmationStatus: commitmentSchema.optional(),
}).passthrough().nullable();

export interface SolanaProviderConfig {
  rpcUrl: string;
  bearerToken?: string;
}

export class SolanaProviderError extends Error {
  constructor(
    readonly code: "not_configured" | "unavailable" | "invalid_response" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "SolanaProviderError";
  }
}

export function solanaProviderConfigFromEnvironment(
  chain: SolanaChain,
  env: NodeJS.ProcessEnv = process.env,
): SolanaProviderConfig | null {
  const suffix = chain === "sol:mainnet" ? "MAINNET" : "DEVNET";
  const rawUrl = env[`SOLANA_${suffix}_RPC_URL`]?.trim();
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const rpcUrl = parsed.toString().replace(/\/$/, "");
  const bearerToken = env[`SOLANA_${suffix}_RPC_BEARER_TOKEN`]?.trim();
  return { rpcUrl, ...(bearerToken ? { bearerToken } : {}) };
}

export async function scanSolanaAddress(args: {
  chain: SolanaChain;
  address: string;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<SolanaScanResponse> {
  const address = parseSolanaAddress(args.address);
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const initialTip = await client.call("getLatestBlockhash", [{ commitment: "finalized" }], latestBlockhashSchema);
  const minContextSlot = safeRpcInteger(initialTip.context.slot);
  const [balance, signatureInfos] = await Promise.all([
    client.call("getBalance", [address, { commitment: "finalized", minContextSlot }], balanceSchema),
    fetchSignatureHistory(client, address, minContextSlot),
  ]);
  if (BigInt(balance.context.slot) < BigInt(initialTip.context.slot)) throw invalidResponse();

  const transactions = await mapWithConcurrency(signatureInfos.items, 4, async (info) => {
    const detail = await client.call(
      "getTransaction",
      [info.signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }],
      transactionSchema,
    );
    return normalizeTransaction(address, info, detail);
  });
  const uniqueTransactions = [...new Map(transactions.map((transaction) => [transaction.signature, transaction])).values()];
  const finalTip = await client.call("getLatestBlockhash", [{ commitment: "finalized" }], latestBlockhashSchema);
  if (BigInt(finalTip.context.slot) < BigInt(initialTip.context.slot) || BigInt(finalTip.context.slot) < BigInt(balance.context.slot)) {
    throw new SolanaProviderError("unavailable", "Solana provider context moved backwards during sync; retry");
  }
  if (finalTip.context.slot === initialTip.context.slot && finalTip.value.blockhash !== initialTip.value.blockhash) {
    throw invalidResponse();
  }
  return {
    snapshot: {
      address,
      slot: finalTip.context.slot,
      blockhash: finalTip.value.blockhash,
      lastValidBlockHeight: finalTip.value.lastValidBlockHeight,
      balanceLamports: balance.value,
      transactions: uniqueTransactions,
      historyCursor: signatureInfos.truncated ? (signatureInfos.items.at(-1)?.signature ?? null) : null,
      historyTruncated: signatureInfos.truncated,
    },
  };
}

export async function getSolanaTransactionStatus(args: {
  signature: string;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<SolanaTransactionStatusResponse> {
  const signature = parseSolanaSignature(args.signature);
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const result = await client.call(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
    z.object({ context: contextSchema, value: z.tuple([statusValueSchema]) }).strict(),
  );
  const status = result.value[0];
  if (!status) return { state: "unknown", slot: null, confirmations: null };
  return {
    state: status.err !== null ? "failed" : (status.confirmationStatus ?? "processed"),
    slot: status.slot,
    confirmations: status.confirmations,
  };
}

class SolanaRpcClient {
  private requestId = 0;

  constructor(
    private readonly config: SolanaProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async call<S extends z.ZodTypeAny>(method: string, params: unknown[], resultSchema: S): Promise<z.output<S>> {
    const id = ++this.requestId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.config.rpcUrl, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.config.bearerToken ? { authorization: `Bearer ${this.config.bearerToken}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw unavailable();
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (!Number.isFinite(contentLength) || contentLength > MAX_RESPONSE_BYTES) throw invalidResponse();
      const text = await readBoundedText(response);
      let parsed: unknown;
      try {
        parsed = JSONBig.parse(text);
      } catch {
        throw invalidResponse();
      }
      const envelope = z.object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(id),
        result: z.unknown().optional(),
        error: z.object({ code: z.number().int().safe(), message: z.string() }).passthrough().optional(),
      }).strict().safeParse(parsed);
      if (!envelope.success || envelope.data.error || !("result" in envelope.data)) throw invalidResponse();
      const result = resultSchema.safeParse(envelope.data.result);
      if (!result.success) throw invalidResponse();
      return result.data;
    } catch (error) {
      if (error instanceof SolanaProviderError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof SolanaProviderError) throw error;
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

async function fetchSignatureHistory(
  client: SolanaRpcClient,
  address: string,
  minContextSlot: number,
): Promise<{ items: z.infer<typeof signatureInfoSchema>[]; truncated: boolean }> {
  const items: z.infer<typeof signatureInfoSchema>[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  let lastPageFull = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const config = {
      commitment: "confirmed",
      minContextSlot,
      limit: HISTORY_PAGE_SIZE,
      ...(before ? { before } : {}),
    };
    const result = await client.call("getSignaturesForAddress", [address, config], z.array(signatureInfoSchema));
    lastPageFull = result.length === HISTORY_PAGE_SIZE;
    for (const info of result) {
      if (!seen.has(info.signature)) {
        seen.add(info.signature);
        items.push(info);
      }
    }
    if (!lastPageFull) return { items, truncated: false };
    const last = result.at(-1);
    if (!last || last.signature === before) throw invalidResponse();
    before = last.signature;
  }
  return { items, truncated: lastPageFull };
}

function normalizeTransaction(
  watchedAddress: string,
  info: z.infer<typeof signatureInfoSchema>,
  detail: z.infer<typeof transactionSchema>,
): SolanaWatchTransaction {
  const state: SolanaTransactionState = info.err !== null
    ? "failed"
    : (info.confirmationStatus ?? "confirmed");
  if (!detail || !detail.meta) {
    return {
      signature: info.signature,
      slot: info.slot,
      blockTime: info.blockTime,
      state,
      netLamports: null,
      feeLamports: detail?.meta?.fee ?? null,
      feePaidByWatched: null,
    };
  }
  if (detail.transaction.signatures[0] !== info.signature || detail.slot !== info.slot) throw invalidResponse();
  const accountKeys = [
    ...detail.transaction.message.accountKeys,
    ...(detail.meta.loadedAddresses?.writable ?? []),
    ...(detail.meta.loadedAddresses?.readonly ?? []),
  ];
  if (detail.meta.preBalances.length !== accountKeys.length || detail.meta.postBalances.length !== accountKeys.length) {
    throw invalidResponse();
  }
  const indexes = accountKeys.flatMap((address, index) => address === watchedAddress ? [index] : []);
  if (indexes.length === 0) throw invalidResponse();
  const netLamports = indexes.reduce(
    (sum, index) => sum + BigInt(detail.meta!.postBalances[index]!) - BigInt(detail.meta!.preBalances[index]!),
    0n,
  );
  return {
    signature: info.signature,
    slot: info.slot,
    blockTime: detail.blockTime ?? info.blockTime,
    state: detail.meta.err !== null ? "failed" : state,
    netLamports: netLamports.toString(),
    feeLamports: detail.meta.fee,
    feePaidByWatched: accountKeys[0] === watchedAddress,
  };
}

export function parseSolanaAddress(value: string): string {
  if (!isCanonicalSolanaAddress(value)) {
    throw new SolanaProviderError("invalid_request", "Solana account address is invalid");
  }
  return value;
}

export function parseSolanaSignature(value: string): string {
  if (!isCanonicalSignature(value)) {
    throw new SolanaProviderError("invalid_request", "Solana transaction signature is invalid");
  }
  return value;
}

function isCanonicalSolanaAddress(value: string): boolean {
  return canonicalBase58Bytes(value, 32);
}

function isCanonicalBlockhash(value: string): boolean {
  return canonicalBase58Bytes(value, 32);
}

function isCanonicalSignature(value: string): boolean {
  return canonicalBase58Bytes(value, 64);
}

function canonicalBase58Bytes(value: string, length: number): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 90) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === length && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function safeRpcInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidResponse();
  return parsed;
}

function unavailable(): SolanaProviderError {
  return new SolanaProviderError("unavailable", "Solana provider is unavailable");
}

function invalidResponse(): SolanaProviderError {
  return new SolanaProviderError("invalid_response", "Solana provider returned an invalid response");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) results[index] = await task(value);
    }
  }));
  return results;
}
