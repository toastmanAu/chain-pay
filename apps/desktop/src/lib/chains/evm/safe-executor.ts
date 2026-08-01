import { getAddress, recoverAddress, type Address, type Hex } from "viem";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import {
  assertSafeReviewBinding,
  ensureInjectedChain,
  requestInjectedAccounts,
  type Eip1193Provider,
} from "./injected-owner-signer";
import { canonicalSafeTxHash, parseSafePayment, type SafePaymentPayload, type SafeTx } from "./safe";

export interface SafeExecutionSignature {
  signer: Address;
  data: Hex;
}

export interface SafeExecutionOperations {
  version(): string;
  owners(): Promise<Address[]>;
  threshold(): Promise<number>;
  hash(tx: SafeTx): Promise<Hex>;
  execute(tx: SafeTx, signatures: SafeExecutionSignature[]): Promise<Hex>;
}

export type SafeExecutionFactory = (
  payload: SafePaymentPayload,
  provider: Eip1193Provider,
  executor: Address,
) => Promise<SafeExecutionOperations>;

export async function executeSafePayment(
  pending: PendingTx,
  multisig: EvmMultisig,
  provider: Eip1193Provider | undefined = window.ethereum,
  factory: SafeExecutionFactory = createExecutionOperations,
): Promise<Hex> {
  if (!provider) throw new Error("No injected EVM wallet found");
  if (pending.state !== "ready_to_broadcast") {
    throw new Error(`Safe payment cannot execute while it is ${pending.state}`);
  }

  const payload = parseSafePayment(pending.payloadJson);
  assertSafeReviewBinding(pending, multisig, payload);
  const canonicalDigest = canonicalSafeTxHash(payload);
  if (canonicalDigest.toLowerCase() !== pending.signingDigest.toLowerCase()) {
    throw new Error("Stored SafeTx hash does not match the reviewed transaction payload");
  }
  const signatures = await verifiedExecutionSignatures(pending, multisig, canonicalDigest);

  const connected = await requestInjectedAccounts(provider);
  await ensureInjectedChain(provider, payload.chainId);
  const executor = connected
    .map((account) => getAddress(account))
    .find((account) => multisig.owners.some((owner) => owner.toLowerCase() === account.toLowerCase()));
  if (!executor) throw new Error("Connect a Safe owner account to execute this payment");

  const operations = await factory(payload, provider, executor);
  if (operations.version() !== payload.safeVersion) {
    throw new Error(
      `Safe version changed: expected ${payload.safeVersion}, received ${operations.version()}`,
    );
  }
  const [currentOwners, currentThreshold] = await Promise.all([
    operations.owners(),
    operations.threshold(),
  ]);
  if (
    currentThreshold !== multisig.threshold ||
    normalizedOwners(currentOwners) !== normalizedOwners(multisig.owners)
  ) {
    throw new Error("Safe owner configuration changed since this payment was approved");
  }
  const protocolDigest = await operations.hash(payload.tx);
  if (protocolDigest.toLowerCase() !== canonicalDigest.toLowerCase()) {
    throw new Error("Protocol Kit SafeTx hash disagrees with the approved transaction");
  }
  const transactionHash = await operations.execute(payload.tx, signatures);
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw new Error("Wallet returned an invalid execution transaction hash");
  }
  return transactionHash;
}

export async function createExecutionOperations(
  payload: SafePaymentPayload,
  provider: Eip1193Provider,
  executor: Address,
): Promise<SafeExecutionOperations> {
  const { default: Safe, EthSafeSignature, EthSafeTransaction } = await import(
    "@safe-global/protocol-kit"
  );
  type SafeInitProvider = Parameters<typeof Safe.init>[0]["provider"];
  const kit = await Safe.init({
    provider: provider as SafeInitProvider,
    signer: executor,
    safeAddress: payload.safeAddress,
  });
  return {
    version: () => kit.getContractVersion(),
    owners: async () => (await kit.getOwners()).map((owner) => getAddress(owner)),
    threshold: () => kit.getThreshold(),
    hash: async (tx) => (await kit.getTransactionHash(new EthSafeTransaction(tx))) as Hex,
    execute: async (tx, signatures) => {
      const signed = new EthSafeTransaction(tx);
      for (const signature of signatures) {
        signed.addSignature(new EthSafeSignature(signature.signer, signature.data));
      }
      const result = await kit.executeTransaction(signed);
      return result.hash as Hex;
    },
  };
}

async function verifiedExecutionSignatures(
  pending: PendingTx,
  multisig: EvmMultisig,
  digest: Hex,
): Promise<SafeExecutionSignature[]> {
  if (pending.signatures.length < multisig.threshold) {
    throw new Error(
      `Safe requires ${multisig.threshold} owner signatures; ${pending.signatures.length} recorded`,
    );
  }
  const seen = new Set<string>();
  const verified: SafeExecutionSignature[] = [];
  for (const stored of pending.signatures) {
    if (stored.bytes.length !== 65) throw new Error("Stored Safe owner signature must be 65 bytes");
    const signer = getAddress(stored.signerHash);
    const signerKey = signer.toLowerCase();
    if (seen.has(signerKey)) throw new Error(`Duplicate Safe owner signature: ${signer}`);
    if (!multisig.owners.some((owner) => owner.toLowerCase() === signerKey)) {
      throw new Error(`Stored signer ${signer} is not a current Safe owner`);
    }
    const data = bytesToHex(stored.bytes);
    const recovered = await recoverAddress({ hash: digest, signature: data });
    if (recovered.toLowerCase() !== signerKey) {
      throw new Error(`Stored signature does not recover to Safe owner ${signer}`);
    }
    seen.add(signerKey);
    verified.push({ signer, data });
  }
  return verified;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizedOwners(owners: readonly string[]): string {
  return owners.map((owner) => owner.toLowerCase()).sort().join(",");
}
