import bs58 from "bs58";
import JSONBigFactory from "json-bigint";
import { z } from "zod";
import { Buffer } from "node:buffer";
import {
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  SystemProgram,
} from "@solana/web3.js";
import type {
  SolanaChain,
  SolanaScanResponse,
  SolanaTransactionState,
  SolanaTransactionStatusResponse,
  SolanaWatchTransaction,
  SolanaPaymentInspection,
  SolanaPaymentPrepareRequest,
  SolanaPaymentPrepareResponse,
  SolanaPaymentReceipt,
  SolanaPaymentSubmitRequest,
  SolanaPaymentFinalizedEvidenceRequest,
  SolanaFinalizedPaymentEvidence,
} from "@chain-pay/shared";
import {
  assembleSignedSolanaTransaction,
  buildSolanaPaymentTransaction,
  isOnCurveSolanaAddress,
  validateSolanaPaymentProposal,
  validateFinalizedSolanaTransaction,
} from "./solana-payment-transaction";

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

const accountValueSchema = z.object({
  data: z.tuple([z.string().max(4_000), z.literal("base64")]),
  executable: z.boolean(),
  lamports: exactUnsignedSchema,
  owner: publicKeySchema,
  rentEpoch: exactUnsignedSchema,
  space: exactUnsignedSchema,
}).strict().nullable();
const accountInfoSchema = z.object({ context: contextSchema, value: accountValueSchema }).strict();
const feeForMessageSchema = z.object({ context: contextSchema, value: exactUnsignedSchema.nullable() }).strict();
const simulationSchema = z.object({
  context: contextSchema,
  value: z.object({
    err: z.unknown().nullable(),
    unitsConsumed: z.number().int().nonnegative().safe().optional(),
  }).passthrough(),
}).strict();
const finalizedPaymentTransactionSchema = z.object({
  slot: exactUnsignedSchema,
  blockTime: z.number().int().safe(),
  version: z.literal("legacy"),
  meta: z.object({ err: z.null(), fee: exactUnsignedSchema }).passthrough(),
  transaction: z.tuple([z.string().min(1).max(4_000), z.literal("base64")]),
}).strict().nullable();

export interface SolanaProviderConfig {
  rpcUrl: string;
  bearerToken?: string;
}

export class SolanaProviderError extends Error {
  constructor(
    readonly code: "not_configured" | "unavailable" | "invalid_response" | "invalid_request" | "unsafe_account" | "stale_nonce" | "insufficient_funds" | "simulation_failed" | "rejected" | "txid_mismatch" | "not_finalized" | "evidence_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "SolanaProviderError";
  }
}

export async function inspectSolanaPayment(args: {
  chain: SolanaChain;
  source: string;
  nonceAccount: string;
  nonceAuthority: string;
  feePayer: string;
  destination?: string;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<SolanaPaymentInspection> {
  const source = parseSolanaAddress(args.source);
  const nonceAccountAddress = parseSolanaAddress(args.nonceAccount);
  const expectedAuthority = parseSolanaAddress(args.nonceAuthority);
  const feePayer = parseSolanaAddress(args.feePayer);
  const destination = args.destination === undefined ? undefined : parseSolanaAddress(args.destination);
  if (!isOnCurveSolanaAddress(source) || !isOnCurveSolanaAddress(feePayer) || !isOnCurveSolanaAddress(expectedAuthority)) {
    throw new SolanaProviderError("unsafe_account", "Solana source, fee payer, and nonce authority must be on-curve public keys");
  }
  if (source === nonceAccountAddress || feePayer === nonceAccountAddress) {
    throw new SolanaProviderError("unsafe_account", "The nonce account cannot be the payment source or fee payer");
  }
  if (destination !== undefined && (destination === source || destination === nonceAccountAddress)) {
    throw new SolanaProviderError("unsafe_account", "Solana payment destination is not allowed");
  }
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const tip = await client.call("getLatestBlockhash", [{ commitment: "finalized" }], latestBlockhashSchema);
  const minContextSlot = safeRpcInteger(tip.context.slot);
  const addresses = [...new Set([source, nonceAccountAddress, feePayer, ...(destination ? [destination] : [])])];
  const accountResults = await Promise.all(addresses.map((address) => getAccount(client, address, minContextSlot)));
  const accounts = new Map(addresses.map((address, index) => [address, accountResults[index]!]));
  const sourceAccount = requireWalletAccount(accounts.get(source), "source");
  const feePayerAccount = requireWalletAccount(accounts.get(feePayer), "fee payer");
  if (destination) requireDestinationWallet(accounts.get(destination), destination);
  const nonceResult = accounts.get(nonceAccountAddress);
  if (!nonceResult?.value || nonceResult.value.owner !== SystemProgram.programId.toBase58() || nonceResult.value.executable) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account is not an initialized System Program account");
  }
  const nonceBytes = decodeCanonicalBase64(nonceResult.value.data[0]);
  if (nonceBytes.length !== NONCE_ACCOUNT_LENGTH || nonceResult.value.space !== String(NONCE_ACCOUNT_LENGTH)) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account has an invalid data layout");
  }
  const nonceData = Buffer.from(nonceBytes);
  if (nonceData.readUInt32LE(0) !== 0 || nonceData.readUInt32LE(4) !== 1) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account is not in the initialized current state");
  }
  let nonce: NonceAccount;
  try {
    nonce = NonceAccount.fromAccountData(nonceBytes);
  } catch {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account is not initialized");
  }
  if (nonce.authorizedPubkey.toBase58() !== expectedAuthority) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce authority does not match the configured public key");
  }
  const nonceRent = await client.call("getMinimumBalanceForRentExemption", [NONCE_ACCOUNT_LENGTH, { commitment: "finalized" }], exactUnsignedSchema);
  if (BigInt(nonceResult.value.lamports) < BigInt(nonceRent)) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account is below the rent-safe balance");
  }
  const maxSlot = [tip.context.slot, ...accountResults.map((item) => item.context.slot)].reduce((max, slot) => BigInt(slot) > BigInt(max) ? slot : max);
  return {
    chain: args.chain,
    source,
    nonceAccount: nonceAccountAddress,
    nonceAuthority: expectedAuthority,
    feePayer,
    sourceBalanceLamports: sourceAccount.lamports,
    nonceBalanceLamports: nonceResult.value.lamports,
    nonceRentMinimumLamports: nonceRent,
    feePayerBalanceLamports: feePayerAccount.lamports,
    durableNonce: nonce.nonce,
    slot: maxSlot,
  };
}

export async function prepareSolanaPayment(args: {
  request: SolanaPaymentPrepareRequest;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<SolanaPaymentPrepareResponse> {
  const amount = canonicalPositiveLamports(args.request.amountLamports);
  const inspection = await inspectSolanaPayment({ ...args.request, destination: args.request.destination, config: args.config, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) });
  const preliminary = buildSolanaPaymentTransaction({ inspection, treasuryId: args.request.treasuryId, destination: args.request.destination, amountLamports: amount, feeLamports: "0" });
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const feeResult = await client.call("getFeeForMessage", [preliminary.messageBase64, { commitment: "confirmed", minContextSlot: safeRpcInteger(inspection.slot) }], feeForMessageSchema);
  if (feeResult.value === null) throw new SolanaProviderError("stale_nonce", "Solana durable nonce is not valid for fee calculation");
  assertPaymentBalances(inspection, amount, feeResult.value);
  const proposal = buildSolanaPaymentTransaction({
    inspection,
    treasuryId: args.request.treasuryId,
    destination: args.request.destination,
    amountLamports: amount,
    feeLamports: feeResult.value,
    ...(args.request.accounting ? { accounting: args.request.accounting } : {}),
  });
  await simulatePayment(client, proposal.unsignedTransactionBase64, safeRpcInteger(inspection.slot), false);
  return { proposal };
}

export async function submitSolanaPayment(args: {
  request: SolanaPaymentSubmitRequest;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<{ receipt: SolanaPaymentReceipt }> {
  const proposal = validateSolanaPaymentProposal(args.request.proposal);
  if (args.request.chain !== proposal.chain || args.request.treasuryId !== proposal.treasuryId) throw new SolanaProviderError("invalid_request", "Solana submission does not match the reviewed payment");
  const assembled = assembleSignedSolanaTransaction(proposal, args.request.signatures);
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const known = await getStatusWithClient(client, assembled.firstSignature);
  if (known.state !== "unknown") return { receipt: paymentReceipt(proposal.reviewDigest, assembled.firstSignature, true) };
  const inspection = await inspectSolanaPayment({
    chain: proposal.chain,
    source: proposal.source,
    nonceAccount: proposal.nonceAccount,
    nonceAuthority: proposal.nonceAuthority,
    feePayer: proposal.feePayer,
    destination: proposal.destination,
    config: args.config,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (inspection.durableNonce !== proposal.durableNonce) throw new SolanaProviderError("stale_nonce", "Solana durable nonce changed after review");
  assertPaymentBalances(inspection, proposal.amountLamports, proposal.feeLamports);
  await simulatePayment(client, Buffer.from(assembled.wireBytes).toString("base64"), safeRpcInteger(inspection.slot), true);
  let returned: string;
  try {
    returned = await client.call("sendTransaction", [Buffer.from(assembled.wireBytes).toString("base64"), {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      minContextSlot: safeRpcInteger(inspection.slot),
      maxRetries: 3,
    }], signatureTextSchema);
  } catch (error) {
    const afterFailure = await getStatusWithClient(client, assembled.firstSignature);
    if (afterFailure.state !== "unknown") return { receipt: paymentReceipt(proposal.reviewDigest, assembled.firstSignature, true) };
    if (error instanceof SolanaProviderError && error.code === "unavailable") throw error;
    throw new SolanaProviderError("rejected", "Solana provider rejected the reviewed transaction");
  }
  if (returned !== assembled.firstSignature) throw new SolanaProviderError("txid_mismatch", "Solana provider returned a mismatched transaction signature");
  return { receipt: paymentReceipt(proposal.reviewDigest, returned, false) };
}

export async function getFinalizedSolanaPaymentEvidence(args: {
  request: SolanaPaymentFinalizedEvidenceRequest;
  config: SolanaProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<{ evidence: SolanaFinalizedPaymentEvidence }> {
  const proposal = validateSolanaPaymentProposal(args.request.proposal);
  if (proposal.version !== 2) throw new SolanaProviderError("invalid_request", "Legacy Solana payments do not contain committed accounting intent");
  if (args.request.chain !== proposal.chain || args.request.treasuryId !== proposal.treasuryId) {
    throw new SolanaProviderError("invalid_request", "Solana finalized-evidence request does not match the reviewed payment");
  }
  const signature = parseSolanaSignature(args.request.receipt.signature);
  if (args.request.receipt.reviewDigest !== proposal.reviewDigest) {
    throw new SolanaProviderError("invalid_request", "Solana receipt does not match the reviewed payment");
  }
  let assembledSignature: string;
  try {
    assembledSignature = assembleSignedSolanaTransaction(proposal, args.request.signatures).firstSignature;
  } catch {
    throw new SolanaProviderError("invalid_request", "Solana finalized-evidence signatures are invalid for the reviewed payment");
  }
  if (assembledSignature !== signature) {
    throw new SolanaProviderError("evidence_mismatch", "Solana receipt signature does not match the reviewed signed transaction");
  }
  const client = new SolanaRpcClient(args.config, args.fetchImpl ?? fetch);
  const finalized = await client.call("getTransaction", [signature, {
    commitment: "finalized",
    encoding: "base64",
    maxSupportedTransactionVersion: 0,
  }], finalizedPaymentTransactionSchema);
  if (!finalized) throw new SolanaProviderError("not_finalized", "Solana payment does not yet have finalized transaction evidence");
  if (BigInt(finalized.slot) < BigInt(proposal.slot)) throw new SolanaProviderError("evidence_mismatch", "Finalized Solana slot predates the reviewed provider context");
  try {
    validateFinalizedSolanaTransaction(proposal, args.request.receipt, finalized.transaction[0]);
  } catch {
    throw new SolanaProviderError("evidence_mismatch", "Finalized Solana transaction does not match the reviewed payment");
  }
  if (finalized.meta.fee !== proposal.feeLamports) {
    throw new SolanaProviderError("evidence_mismatch", "Finalized Solana fee does not match the reviewed fee");
  }
  const finalizedAt = new Date(finalized.blockTime * 1_000);
  if (Number.isNaN(finalizedAt.valueOf())) throw invalidResponse();
  return { evidence: {
    version: 1,
    chain: proposal.chain,
    reviewDigest: proposal.reviewDigest,
    signature,
    slot: finalized.slot,
    finalizedAt: finalizedAt.toISOString(),
    transactionVersion: "legacy",
    messageBase64: proposal.messageBase64,
    signedTransactionBase64: finalized.transaction[0],
    source: proposal.source,
    destination: proposal.destination,
    amountLamports: proposal.amountLamports,
    feePayer: proposal.feePayer,
    feeLamports: finalized.meta.fee,
    feePayerPolicy: "transaction_fee_payer",
    nonceAccount: proposal.nonceAccount,
    nonceAuthority: proposal.nonceAuthority,
    durableNonce: proposal.durableNonce,
  } };
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
  return getStatusWithClient(client, signature);
}

async function getStatusWithClient(
  client: SolanaRpcClient,
  signature: string,
): Promise<SolanaTransactionStatusResponse> {
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

async function getAccount(client: SolanaRpcClient, address: string, minContextSlot: number): Promise<z.output<typeof accountInfoSchema>> {
  const result = await client.call("getAccountInfo", [address, { commitment: "finalized", encoding: "base64", minContextSlot }], accountInfoSchema);
  if (BigInt(result.context.slot) < BigInt(minContextSlot)) throw invalidResponse();
  return result;
}

function requireWalletAccount(result: z.output<typeof accountInfoSchema> | undefined, label: string): NonNullable<z.output<typeof accountValueSchema>> {
  if (!result?.value || result.value.owner !== SystemProgram.programId.toBase58() || result.value.executable || result.value.space !== "0" || result.value.data[0] !== "") {
    throw new SolanaProviderError("unsafe_account", `Solana ${label} is not a safe System Program wallet`);
  }
  return result.value;
}

function requireDestinationWallet(result: z.output<typeof accountInfoSchema> | undefined, address: string): void {
  if (!result) throw invalidResponse();
  if (!isOnCurveSolanaAddress(address)) throw new SolanaProviderError("unsafe_account", "Solana destination must be an on-curve wallet public key");
  if (result.value === null) {
    return;
  }
  requireWalletAccount(result, "destination");
}

function decodeCanonicalBase64(value: string): Uint8Array {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("noncanonical base64");
    return bytes;
  } catch {
    throw invalidResponse();
  }
}

function canonicalPositiveLamports(value: string): string {
  if (!DECIMAL.test(value)) throw new SolanaProviderError("invalid_request", "Solana amount must be canonical lamport integer text");
  const amount = BigInt(value);
  if (amount <= 0n || amount > U64_MAX) throw new SolanaProviderError("invalid_request", "Solana amount is outside the supported lamport range");
  return amount.toString();
}

function assertPaymentBalances(inspection: SolanaPaymentInspection, amountText: string, feeText: string): void {
  const amount = BigInt(amountText);
  const fee = BigInt(feeText);
  const sourceRequired = amount + (inspection.source === inspection.feePayer ? fee : 0n);
  if (BigInt(inspection.sourceBalanceLamports) < sourceRequired) throw new SolanaProviderError("insufficient_funds", "Solana source balance does not cover the reviewed payment");
  if (inspection.source !== inspection.feePayer && BigInt(inspection.feePayerBalanceLamports) < fee) {
    throw new SolanaProviderError("insufficient_funds", "Solana fee payer balance does not cover the reviewed fee");
  }
  if (BigInt(inspection.nonceBalanceLamports) < BigInt(inspection.nonceRentMinimumLamports)) {
    throw new SolanaProviderError("unsafe_account", "Solana nonce account is below the rent-safe balance");
  }
}

async function simulatePayment(client: SolanaRpcClient, transactionBase64: string, minContextSlot: number, sigVerify: boolean): Promise<void> {
  const result = await client.call("simulateTransaction", [transactionBase64, {
    encoding: "base64",
    commitment: "confirmed",
    sigVerify,
    replaceRecentBlockhash: false,
    minContextSlot,
    innerInstructions: false,
  }], simulationSchema);
  if (result.value.err !== null) throw new SolanaProviderError("simulation_failed", "Solana payment simulation failed");
}

function paymentReceipt(reviewDigest: string, signature: string, alreadySubmitted: boolean): SolanaPaymentReceipt {
  return { signature, reviewDigest, submittedAt: new Date().toISOString(), alreadySubmitted };
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
