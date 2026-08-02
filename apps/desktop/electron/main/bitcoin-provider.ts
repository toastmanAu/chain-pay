import { z } from "zod";
import { Address, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import type {
  BitcoinAddressActivity,
  BitcoinChain,
  BitcoinScanResponse,
  BitcoinWatchTransaction,
  BitcoinWatchUtxo,
  BitcoinTransactionStatusResponse,
} from "@chain-pay/shared";

const HASH = /^[0-9a-f]{64}$/;
const MAX_ADDRESSES_PER_SCAN = 10_000;
const MAX_HISTORY_PAGES = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const statusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: z.string().regex(HASH).optional(),
  block_time: z.number().int().nonnegative().optional(),
});

const prevoutSchema = z.object({
  scriptpubkey_address: z.string().optional(),
  value: z.number().int().nonnegative().safe(),
}).nullable();

const txSchema = z.object({
  txid: z.string().regex(HASH),
  vin: z.array(z.object({ prevout: prevoutSchema })),
  vout: z.array(
    z.object({
      scriptpubkey_address: z.string().optional(),
      value: z.number().int().nonnegative().safe(),
    }),
  ),
  status: statusSchema,
});

const utxoSchema = z.object({
  txid: z.string().regex(HASH),
  vout: z.number().int().nonnegative().safe(),
  value: z.number().int().nonnegative().safe(),
  status: statusSchema,
});

const addressStatsSchema = z.object({
  chain_stats: z.object({ tx_count: z.number().int().nonnegative().safe() }).passthrough(),
  mempool_stats: z.object({ tx_count: z.number().int().nonnegative().safe() }).passthrough(),
}).passthrough();

type EsploraTx = z.infer<typeof txSchema>;
type EsploraUtxo = z.infer<typeof utxoSchema>;

export interface BitcoinProviderConfig {
  baseUrl: string;
  bearerToken?: string;
}

export class BitcoinProviderError extends Error {
  constructor(
    readonly code: "not_configured" | "unavailable" | "invalid_response" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "BitcoinProviderError";
  }
}

export function providerConfigFromEnvironment(
  chain: BitcoinChain,
  env: NodeJS.ProcessEnv = process.env,
): BitcoinProviderConfig | null {
  const suffix = chain === "btc:mainnet" ? "MAINNET" : "TESTNET";
  const rawUrl = env[`BITCOIN_${suffix}_ESPLORA_URL`]?.trim();
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
  const baseUrl = parsed.toString().replace(/\/$/, "");
  const bearerToken = env[`BITCOIN_${suffix}_ESPLORA_BEARER_TOKEN`]?.trim();
  return { baseUrl, ...(bearerToken ? { bearerToken } : {}) };
}

export async function scanBitcoinAddresses(args: {
  chain: BitcoinChain;
  addresses: string[];
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinScanResponse> {
  validateAddresses(args.chain, args.addresses);
  const fetchImpl = args.fetchImpl ?? fetch;
  const client = new EsploraClient(args.config, fetchImpl);
  const [tipHeightText, tipHashText] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
  ]);
  const tipHeight = parseHeight(tipHeightText);
  const tipHash = parseHash(tipHashText);
  const watched = new Set(args.addresses);

  const results = await mapWithConcurrency(args.addresses, 4, async (address) => {
    const encoded = encodeURIComponent(address);
    const stats = await client.json(`/address/${encoded}`, addressStatsSchema);
    const used = stats.chain_stats.tx_count > 0 || stats.mempool_stats.tx_count > 0;
    if (!used) return { address, transactions: [], utxos: [], used: false };
    const [transactions, utxos] = await Promise.all([
      fetchAddressTransactions(client, address),
      client.json(`/address/${encoded}/utxo`, z.array(utxoSchema)),
    ]);
    return { address, transactions, utxos, used: true };
  });

  const blockHeights = new Set<number>();
  for (const result of results) {
    for (const tx of result.transactions) if (tx.status.confirmed && tx.status.block_height !== undefined) blockHeights.add(tx.status.block_height);
    for (const utxo of result.utxos) if (utxo.status.confirmed && utxo.status.block_height !== undefined) blockHeights.add(utxo.status.block_height);
  }
  const canonicalHashes = new Map<number, string>();
  await mapWithConcurrency([...blockHeights], 6, async (height) => {
    canonicalHashes.set(height, parseHash(await client.text(`/block-height/${height}`)));
  });

  const transactionsById = new Map<string, EsploraTx>();
  const utxosByOutpoint = new Map<string, { address: string; utxo: EsploraUtxo }>();
  const activity: BitcoinAddressActivity[] = [];
  for (const result of results) {
    activity.push({
      address: result.address,
      used: result.used,
    });
    for (const tx of result.transactions) transactionsById.set(tx.txid, tx);
    for (const utxo of result.utxos) {
      utxosByOutpoint.set(`${utxo.txid}:${utxo.vout}`, { address: result.address, utxo });
    }
  }

  const utxos = [...utxosByOutpoint.values()]
    .map(({ address, utxo }) => ({ normalized: normalizeUtxo(address, utxo, tipHeight, canonicalHashes), source: utxo }))
    // A provider response can straddle a reorg. An output claimed as confirmed
    // in a non-canonical block must not inflate the spendable-looking balance.
    .filter(({ normalized, source }) => !source.status.confirmed || normalized.confirmed)
    .map(({ normalized }) => normalized);
  const transactions = [...transactionsById.values()]
    .map((tx) => normalizeTransaction(tx, watched, tipHeight, canonicalHashes))
    .sort(compareTransactions);
  const balanceSats = utxos.reduce((sum, utxo) => sum + BigInt(utxo.valueSats), 0n).toString();
  const [finalTipHeightText, finalTipHashText] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.text("/blocks/tip/hash"),
  ]);
  if (parseHeight(finalTipHeightText) !== tipHeight || parseHash(finalTipHashText) !== tipHash) {
    throw new BitcoinProviderError("unavailable", "Bitcoin chain tip changed during sync; retry");
  }

  return {
    snapshot: {
      tipHeight,
      tipHash,
      balanceSats,
      addresses: [...args.addresses],
      utxos: utxos.sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
      transactions,
    },
    activity,
  };
}

export async function getBitcoinTransactionStatus(args: {
  txid: string;
  config: BitcoinProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<BitcoinTransactionStatusResponse> {
  if (!HASH.test(args.txid)) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin transaction id is invalid");
  }
  const client = new EsploraClient(args.config, args.fetchImpl ?? fetch);
  const [tipHeightText, status] = await Promise.all([
    client.text("/blocks/tip/height"),
    client.json(`/tx/${args.txid}/status`, statusSchema),
  ]);
  const tipHeight = parseHeight(tipHeightText);
  if (!status.confirmed) {
    return { state: "pending", confirmations: 0, blockHeight: null, blockHash: null };
  }
  if (status.block_height === undefined || status.block_hash === undefined) {
    throw invalidResponse();
  }
  const canonicalHash = parseHash(await client.text(`/block-height/${status.block_height}`));
  if (canonicalHash !== status.block_hash || status.block_height > tipHeight) {
    return { state: "pending", confirmations: 0, blockHeight: null, blockHash: null };
  }
  const confirmations = tipHeight - status.block_height + 1;
  return {
    state: confirmations >= 6 ? "confirmed" : "confirming",
    confirmations,
    blockHeight: status.block_height,
    blockHash: status.block_hash,
  };
}

class EsploraClient {
  constructor(
    private readonly config: BitcoinProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async text(path: string): Promise<string> {
    const response = await this.request(path);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    return text.trim();
  }

  async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(path);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) throw invalidResponse();
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw invalidResponse();
    }
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json, text/plain",
          ...(this.config.bearerToken
            ? { authorization: `Bearer ${this.config.bearerToken}` }
            : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) throw unavailable();
      return response;
    } catch (error) {
      if (error instanceof BitcoinProviderError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchAddressTransactions(client: EsploraClient, address: string): Promise<EsploraTx[]> {
  const encoded = encodeURIComponent(address);
  const first = await client.json(`/address/${encoded}/txs`, z.array(txSchema));
  const all = [...first];
  // The first endpoint can contain up to 50 mempool entries plus exactly one
  // 25-item confirmed page. Continue from the last confirmed tx, never from a
  // mempool txid.
  let page = first.filter((tx) => tx.status.confirmed);
  let pages = 1;
  while (page.length === 25) {
    if (pages++ >= MAX_HISTORY_PAGES) throw invalidResponse();
    const last = page.at(-1);
    if (!last) break;
    page = await client.json(`/address/${encoded}/txs/chain/${last.txid}`, z.array(txSchema));
    if (page.length === 0) break;
    all.push(...page);
  }
  const unique = new Map(all.map((tx) => [tx.txid, tx]));
  return [...unique.values()];
}

function normalizeUtxo(
  address: string,
  utxo: EsploraUtxo,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): BitcoinWatchUtxo {
  const canonical = canonicalStatus(utxo.status, tipHeight, canonicalHashes);
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    address,
    valueSats: BigInt(utxo.value).toString(),
    ...canonical,
  };
}

function normalizeTransaction(
  tx: EsploraTx,
  watched: Set<string>,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): BitcoinWatchTransaction {
  let net = 0n;
  for (const input of tx.vin) {
    if (input.prevout?.scriptpubkey_address && watched.has(input.prevout.scriptpubkey_address)) {
      net -= BigInt(input.prevout.value);
    }
  }
  for (const output of tx.vout) {
    if (output.scriptpubkey_address && watched.has(output.scriptpubkey_address)) {
      net += BigInt(output.value);
    }
  }
  const canonical = canonicalStatus(tx.status, tipHeight, canonicalHashes);
  return {
    txid: tx.txid,
    netValueSats: net.toString(),
    ...canonical,
    blockTime: canonical.confirmed ? (tx.status.block_time ?? null) : null,
  };
}

function canonicalStatus(
  status: z.infer<typeof statusSchema>,
  tipHeight: number,
  canonicalHashes: Map<number, string>,
): Pick<BitcoinWatchUtxo, "confirmed" | "blockHeight" | "blockHash" | "confirmations"> {
  const height = status.block_height;
  const hash = status.block_hash;
  const confirmed =
    status.confirmed &&
    height !== undefined &&
    hash !== undefined &&
    height <= tipHeight &&
    canonicalHashes.get(height) === hash;
  return confirmed
    ? { confirmed: true, blockHeight: height, blockHash: hash, confirmations: tipHeight - height + 1 }
    : { confirmed: false, blockHeight: null, blockHash: null, confirmations: 0 };
}

function compareTransactions(a: BitcoinWatchTransaction, b: BitcoinWatchTransaction): number {
  if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
  if ((a.blockHeight ?? -1) !== (b.blockHeight ?? -1)) return (b.blockHeight ?? -1) - (a.blockHeight ?? -1);
  return a.txid.localeCompare(b.txid);
}

function validateAddresses(chain: BitcoinChain, addresses: string[]): void {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES_PER_SCAN) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan address count is invalid");
  }
  const unique = new Set(addresses);
  if (unique.size !== addresses.length || addresses.some((address) => typeof address !== "string" || address.length < 14 || address.length > 90)) {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan addresses are invalid");
  }
  const coder = Address(chain === "btc:mainnet" ? NETWORK : TEST_NETWORK);
  try {
    for (const address of addresses) {
      const decoded = coder.decode(address);
      if (!decoded || coder.encode(decoded) !== address) throw new Error("non-canonical address");
    }
  } catch {
    throw new BitcoinProviderError("invalid_request", "Bitcoin scan addresses are invalid");
  }
}

function parseHeight(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw invalidResponse();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidResponse();
  return parsed;
}

function parseHash(value: string): string {
  if (!HASH.test(value)) throw invalidResponse();
  return value;
}

function unavailable(): BitcoinProviderError {
  return new BitcoinProviderError("unavailable", "Bitcoin provider is unavailable");
}

function invalidResponse(): BitcoinProviderError {
  return new BitcoinProviderError("invalid_response", "Bitcoin provider returned an invalid response");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        const value = values[index];
        if (value !== undefined) results[index] = await task(value);
      }
    }),
  );
  return results;
}
