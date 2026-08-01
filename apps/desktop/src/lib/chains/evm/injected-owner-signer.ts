import { getAddress, isAddress, recoverAddress, type Address, type Hex } from "viem";
import type { EvmMultisig, PartialSignature, PendingTx } from "@chain-pay/shared";
import { canonicalSafeTxHash, parseSafePayment, type SafePaymentPayload, type SafeTx } from "./safe";

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

export interface SafeSigningOperations {
  version(): string;
  hash(tx: SafeTx): Promise<Hex>;
  signTypedData(tx: SafeTx): Promise<{ signer: string; data: Hex }>;
}

export type SafeSigningFactory = (
  payload: SafePaymentPayload,
  provider: Eip1193Provider,
  signer: Address,
) => Promise<SafeSigningOperations>;

export async function approveSafePayment(
  pending: PendingTx,
  multisig: EvmMultisig,
  provider: Eip1193Provider | undefined = window.ethereum,
  factory: SafeSigningFactory = createSigningOperations,
): Promise<PartialSignature> {
  if (!provider) throw new Error("No injected EVM wallet found. Install or open a browser wallet first.");
  const payload = parseSafePayment(pending.payloadJson);
  assertSafeReviewBinding(pending, multisig, payload);
  if (canonicalSafeTxHash(payload).toLowerCase() !== pending.signingDigest.toLowerCase()) {
    throw new Error("Stored SafeTx hash does not match the reviewed transaction payload");
  }

  const accounts = await requestInjectedAccounts(provider);
  await ensureInjectedChain(provider, payload.chainId);
  const connected = accounts.map((account) => getAddress(account));
  const signer = connected.find((account) =>
    multisig.owners.some((owner) => owner.toLowerCase() === account.toLowerCase()),
  );
  if (!signer) {
    throw new Error(`Connected account ${connected[0]} is not an owner of this Safe`);
  }

  const operations = await factory(payload, provider, signer);
  if (operations.version() !== payload.safeVersion) {
    throw new Error(
      `Safe version changed: expected ${payload.safeVersion}, received ${operations.version()}`,
    );
  }
  const recomputedDigest = await operations.hash(payload.tx);
  if (recomputedDigest.toLowerCase() !== pending.signingDigest.toLowerCase()) {
    throw new Error("Stored SafeTx hash does not match the reviewed transaction payload");
  }

  const signature = await operations.signTypedData(payload.tx);
  if (signature.signer.toLowerCase() !== signer.toLowerCase()) {
    throw new Error("Wallet returned a signature for a different account");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature.data)) {
    throw new Error("Wallet returned a malformed Safe owner signature");
  }
  const recovered = await recoverAddress({ hash: recomputedDigest, signature: signature.data });
  if (recovered.toLowerCase() !== signer.toLowerCase()) {
    throw new Error("Safe EIP-712 signature does not recover to the connected owner");
  }

  return {
    signerHash: signer,
    bytes: hexToBytes(signature.data),
    signedAt: Date.now(),
  };
}

export async function createSigningOperations(
  payload: SafePaymentPayload,
  provider: Eip1193Provider,
  signer: Address,
): Promise<SafeSigningOperations> {
  const { default: Safe, EthSafeTransaction } = await import("@safe-global/protocol-kit");
  type SafeInitProvider = Parameters<typeof Safe.init>[0]["provider"];
  const kit = await Safe.init({
    provider: provider as SafeInitProvider,
    signer,
    safeAddress: payload.safeAddress,
  });
  return {
    version: () => kit.getContractVersion(),
    hash: async (tx) => (await kit.getTransactionHash(new EthSafeTransaction(tx))) as Hex,
    signTypedData: async (tx) => {
      const signature = await kit.signTypedData(new EthSafeTransaction(tx), "v4");
      return { signer: signature.signer, data: signature.data as Hex };
    },
  };
}

export async function requestInjectedAccounts(provider: Eip1193Provider): Promise<string[]> {
  const result = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(result) || result.length === 0 || result.some((value) => typeof value !== "string")) {
    throw new Error("Wallet did not return a connected account");
  }
  if (result.some((account) => !isAddress(account, { strict: false }))) {
    throw new Error("Wallet returned an invalid account address");
  }
  return result as string[];
}

export async function ensureInjectedChain(
  provider: Eip1193Provider,
  expectedChainId: number,
): Promise<void> {
  let actual = parseChainId(await provider.request({ method: "eth_chainId" }));
  if (actual === expectedChainId) return;
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: `0x${expectedChainId.toString(16)}` }],
  });
  actual = parseChainId(await provider.request({ method: "eth_chainId" }));
  if (actual !== expectedChainId) {
    throw new Error(`Wallet chain mismatch: expected ${expectedChainId}, received ${actual}`);
  }
}

function parseChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Wallet returned an invalid chain ID");
  }
  return Number.parseInt(value.slice(2), 16);
}

export function assertSafeReviewBinding(
  pending: PendingTx,
  multisig: EvmMultisig,
  payload: SafePaymentPayload,
): void {
  if (pending.chain !== multisig.chain || pending.chain !== `evm:${payload.chainId}`) {
    throw new Error("Pending transaction, payload, and treasury chain do not match");
  }
  if (payload.safeAddress.toLowerCase() !== multisig.address.toLowerCase()) {
    throw new Error("Safe payment payload belongs to a different treasury");
  }
  if (payload.safeVersion !== multisig.version) throw new Error("Safe version changed since payment creation");
  if (pending.outputs.length !== 1) throw new Error("Slice B requires exactly one native ETH output");
  const output = pending.outputs[0]!;
  if (
    output.amount.asset !== "ETH" ||
    output.amount.decimals !== 18 ||
    output.to.toLowerCase() !== payload.tx.to.toLowerCase() ||
    output.amount.value !== payload.tx.value
  ) {
    throw new Error("Reviewed payment output does not match the Safe transaction payload");
  }
  if (payload.tx.data !== "0x" || payload.tx.operation !== 0) {
    throw new Error("Slice B only signs native ETH transfers with empty calldata");
  }
}

function hexToBytes(hex: Hex): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}
