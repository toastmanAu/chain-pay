import { getAddress, hashTypedData, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { EvmAddress } from "@chain-pay/shared";
import { getEvmRpcUrl } from "./public-client";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT_RE = /^(0|[1-9]\d*)$/;
const SUPPORTED_SAFE_VERSIONS = ["1.3.0", "1.4.1"] as const;
const SAFE_TX_TYPES = [
  { type: "address", name: "to" },
  { type: "uint256", name: "value" },
  { type: "bytes", name: "data" },
  { type: "uint8", name: "operation" },
  { type: "uint256", name: "safeTxGas" },
  { type: "uint256", name: "baseGas" },
  { type: "uint256", name: "gasPrice" },
  { type: "address", name: "gasToken" },
  { type: "address", name: "refundReceiver" },
  { type: "uint256", name: "nonce" },
] as const;

export interface SafeConfig {
  chainId: number;
  address: EvmAddress;
  owners: EvmAddress[];
  threshold: number;
  version: string;
}

/** Exact serialisable shape signed by a Safe owner. Integer fields stay decimal strings. */
export interface SafeTx {
  to: EvmAddress;
  value: string;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: EvmAddress;
  refundReceiver: EvmAddress;
  nonce: number;
}

export interface SafePaymentPayload {
  schemaVersion: 1;
  chainId: number;
  safeAddress: EvmAddress;
  safeVersion: string;
  tx: SafeTx;
}

export interface SafeProtocolOperations {
  chainId(): Promise<number>;
  version(): string;
  createNativeTransfer(to: Address, valueWei: bigint): Promise<SafeTx>;
  hash(tx: SafeTx): Promise<Hex>;
}

export type SafeProtocolFactory = (cfg: SafeConfig) => Promise<SafeProtocolOperations>;

const addressSchema = z.string().refine((value) => isAddress(value, { strict: false }), "invalid EVM address");
const uintSchema = z.string().regex(UINT_RE, "expected an unsigned decimal integer");
const safeTxSchema = z.object({
  to: addressSchema,
  value: uintSchema,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/, "invalid transaction data"),
  operation: z.union([z.literal(0), z.literal(1)]),
  safeTxGas: uintSchema,
  baseGas: uintSchema,
  gasPrice: uintSchema,
  gasToken: addressSchema,
  refundReceiver: addressSchema,
  nonce: z.number().int().nonnegative(),
});

const safePaymentPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  chainId: z.literal(11155111),
  safeAddress: addressSchema,
  safeVersion: z.enum(SUPPORTED_SAFE_VERSIONS),
  tx: safeTxSchema,
});

export async function buildNativeSafePayment(
  cfg: SafeConfig,
  recipient: string,
  valueWei: bigint,
  factory: SafeProtocolFactory = createSafeProtocol,
): Promise<{ payload: SafePaymentPayload; signingDigest: Hex }> {
  assertConfig(cfg);
  if (!isAddress(recipient, { strict: false })) throw new Error("Enter a valid recipient address");
  if (valueWei <= 0n) throw new Error("Payment amount must be greater than zero");

  const protocol = await factory(cfg);
  const connectedChainId = await protocol.chainId();
  if (connectedChainId !== cfg.chainId) {
    throw new Error(`RPC chain mismatch: expected ${cfg.chainId}, received ${connectedChainId}`);
  }
  const version = protocol.version();
  if (version !== cfg.version) {
    throw new Error(`Safe version changed: expected ${cfg.version}, received ${version}`);
  }

  const tx = normalizeSafeTx(await protocol.createNativeTransfer(getAddress(recipient), valueWei));
  assertNativeTransfer(tx, getAddress(recipient), valueWei);
  const signingDigest = await protocol.hash(tx);
  assertDigest(signingDigest);
  const payload = parseSafePayment(
    JSON.stringify({
      schemaVersion: 1,
      chainId: cfg.chainId,
      safeAddress: getAddress(cfg.address),
      safeVersion: version,
      tx,
    }),
  );
  const canonicalDigest = canonicalSafeTxHash(payload);
  if (canonicalDigest.toLowerCase() !== signingDigest.toLowerCase()) {
    throw new Error("Protocol Kit SafeTx hash disagrees with the canonical EIP-712 payload hash");
  }
  return { payload, signingDigest: canonicalDigest };
}

export async function safeTxHash(
  cfg: SafeConfig,
  tx: SafeTx,
  factory: SafeProtocolFactory = createSafeProtocol,
): Promise<Hex> {
  assertConfig(cfg);
  const protocol = await factory(cfg);
  const chainId = await protocol.chainId();
  if (chainId !== cfg.chainId) {
    throw new Error(`RPC chain mismatch: expected ${cfg.chainId}, received ${chainId}`);
  }
  const normalized = normalizeSafeTx(tx);
  const digest = await protocol.hash(normalized);
  assertDigest(digest);
  const canonical = canonicalSafeTxHash({
    schemaVersion: 1,
    chainId: cfg.chainId,
    safeAddress: getAddress(cfg.address),
    safeVersion: cfg.version,
    tx: normalized,
  });
  if (canonical.toLowerCase() !== digest.toLowerCase()) {
    throw new Error("Protocol Kit SafeTx hash disagrees with the canonical EIP-712 payload hash");
  }
  return canonical;
}

export function canonicalSafeTxHash(payload: SafePaymentPayload): Hex {
  return hashTypedData({
    domain: { chainId: payload.chainId, verifyingContract: payload.safeAddress },
    primaryType: "SafeTx",
    types: { SafeTx: SAFE_TX_TYPES },
    message: {
      ...payload.tx,
      value: BigInt(payload.tx.value),
      safeTxGas: BigInt(payload.tx.safeTxGas),
      baseGas: BigInt(payload.tx.baseGas),
      gasPrice: BigInt(payload.tx.gasPrice),
      nonce: BigInt(payload.tx.nonce),
    },
  });
}

export function serializeSafePayment(payload: SafePaymentPayload): string {
  return JSON.stringify(parseSafePayment(JSON.stringify(payload)));
}

export function parseSafePayment(payloadJson: string): SafePaymentPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new Error("Safe payment payload is not valid JSON");
  }
  const result = safePaymentPayloadSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid Safe payment payload: ${result.error.issues[0]?.message}`);
  return {
    ...result.data,
    safeAddress: getAddress(result.data.safeAddress),
    tx: normalizeSafeTx(result.data.tx),
  };
}

export async function createSafeProtocol(cfg: SafeConfig): Promise<SafeProtocolOperations> {
  const { default: Safe, EthSafeTransaction } = await import("@safe-global/protocol-kit");
  const kit = await Safe.init({ provider: getEvmRpcUrl(cfg.chainId), safeAddress: cfg.address });
  return {
    chainId: async () => Number(await kit.getChainId()),
    version: () => kit.getContractVersion(),
    createNativeTransfer: async (to, valueWei) => {
      const transaction = await kit.createTransaction({
        transactions: [{ to, value: valueWei.toString(), data: "0x" }],
      });
      return normalizeSafeTx(transaction.data);
    },
    hash: async (tx) => (await kit.getTransactionHash(new EthSafeTransaction(tx))) as Hex,
  };
}

function assertConfig(cfg: SafeConfig): void {
  if (cfg.chainId !== 11155111) throw new Error("Only Sepolia Safe payments are enabled");
  if (!isAddress(cfg.address, { strict: false })) throw new Error("Treasury has an invalid Safe address");
  if (!SUPPORTED_SAFE_VERSIONS.includes(cfg.version as (typeof SUPPORTED_SAFE_VERSIONS)[number])) {
    throw new Error(`Safe version ${cfg.version} is not supported for EIP-712 approval`);
  }
}

function normalizeSafeTx(tx: {
  to: string;
  value: string;
  data: string;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}): SafeTx {
  return {
    ...tx,
    to: getAddress(tx.to),
    value: String(tx.value),
    data: tx.data as Hex,
    safeTxGas: String(tx.safeTxGas),
    baseGas: String(tx.baseGas),
    gasPrice: String(tx.gasPrice),
    gasToken: getAddress(tx.gasToken),
    refundReceiver: getAddress(tx.refundReceiver),
    nonce: Number(tx.nonce),
  };
}

function assertNativeTransfer(tx: SafeTx, recipient: Address, valueWei: bigint): void {
  if (tx.to !== recipient || tx.value !== valueWei.toString()) {
    throw new Error("Protocol Kit returned payment details that do not match the request");
  }
  if (tx.data !== "0x" || tx.operation !== 0) {
    throw new Error("Slice B only permits a native ETH call with empty calldata");
  }
  if (tx.gasToken.toLowerCase() !== ZERO_ADDRESS || tx.refundReceiver.toLowerCase() !== ZERO_ADDRESS) {
    throw new Error("Slice B requires Safe gas payment fields to use the zero address");
  }
}

function assertDigest(digest: string): asserts digest is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("Protocol Kit returned an invalid SafeTx hash");
}
