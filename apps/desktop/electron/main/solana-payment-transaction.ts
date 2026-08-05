import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { ed25519 } from "@noble/curves-v2/ed25519.js";
import bs58 from "bs58";
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { z } from "zod";
import type {
  SolanaChain,
  SolanaPaymentInspection,
  SolanaPaymentProposal,
  SolanaSignatureEnvelope,
} from "@chain-pay/shared";

export const MAX_SOLANA_TRANSACTION_BYTES = 1_232;
const U64_MAX = 18_446_744_073_709_551_615n;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const BASE58_ADDRESS = z.string().min(32).max(44).refine(canonicalAddress);
const BASE58_SIGNATURE = z.string().min(80).max(90).refine(canonicalSignature);
const BASE64 = z.string().min(1).max(4_000).refine(canonicalBase64);
const chainSchema = z.enum(["sol:mainnet", "sol:devnet"]);
const decimalSchema = z.string().regex(DECIMAL).refine((value) => BigInt(value) <= U64_MAX);

export const solanaPaymentProposalSchema = z.object({
  version: z.literal(1),
  chain: chainSchema,
  treasuryId: z.string().min(1).max(200),
  source: BASE58_ADDRESS,
  destination: BASE58_ADDRESS,
  nonceAccount: BASE58_ADDRESS,
  nonceAuthority: BASE58_ADDRESS,
  feePayer: BASE58_ADDRESS,
  amountLamports: decimalSchema.refine((value) => BigInt(value) > 0n),
  feeLamports: decimalSchema,
  sourceBalanceLamports: decimalSchema,
  nonceBalanceLamports: decimalSchema,
  nonceRentMinimumLamports: decimalSchema,
  feePayerBalanceLamports: decimalSchema,
  durableNonce: BASE58_ADDRESS,
  slot: decimalSchema,
  messageBase64: BASE64,
  unsignedTransactionBase64: BASE64,
  requiredSigners: z.array(BASE58_ADDRESS).min(1).max(3).refine((values) => new Set(values).size === values.length),
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
}).strict();

export const solanaSignatureEnvelopeSchema = z.object({
  format: z.literal("chainpay-solana-signature-v1"),
  chain: chainSchema,
  treasuryId: z.string().min(1).max(200),
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  signer: BASE58_ADDRESS,
  signature: BASE58_SIGNATURE,
}).strict();

export function buildSolanaPaymentTransaction(args: {
  inspection: SolanaPaymentInspection;
  treasuryId: string;
  destination: string;
  amountLamports: string;
  feeLamports: string;
  createdAt?: string;
}): SolanaPaymentProposal {
  const source = new PublicKey(args.inspection.source);
  const destination = new PublicKey(args.destination);
  const nonceAccount = new PublicKey(args.inspection.nonceAccount);
  const nonceAuthority = new PublicKey(args.inspection.nonceAuthority);
  const feePayer = new PublicKey(args.inspection.feePayer);
  const transaction = new Transaction({
    feePayer,
    recentBlockhash: args.inspection.durableNonce,
  }).add(
    SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: nonceAuthority }),
    SystemProgram.transfer({ fromPubkey: source, toPubkey: destination, lamports: BigInt(args.amountLamports) }),
  );
  const message = transaction.serializeMessage();
  const requiredSigners = deriveRequiredSigners(transaction);
  const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (unsigned.length > MAX_SOLANA_TRANSACTION_BYTES) throw new Error("Solana transaction exceeds the wire-size limit");
  const withoutDigest = {
    version: 1 as const,
    ...args.inspection,
    treasuryId: args.treasuryId,
    destination: destination.toBase58(),
    amountLamports: canonicalU64(args.amountLamports, false),
    feeLamports: canonicalU64(args.feeLamports, true),
    messageBase64: Buffer.from(message).toString("base64"),
    unsignedTransactionBase64: Buffer.from(unsigned).toString("base64"),
    requiredSigners,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
  return { ...withoutDigest, reviewDigest: computeSolanaReviewDigest(withoutDigest) };
}

export function computeSolanaReviewDigest(proposal: Omit<SolanaPaymentProposal, "reviewDigest">): string {
  const committed = [
    proposal.version,
    proposal.chain,
    proposal.treasuryId,
    proposal.source,
    proposal.destination,
    proposal.amountLamports,
    proposal.feePayer,
    proposal.nonceAccount,
    proposal.nonceAuthority,
    proposal.durableNonce,
    proposal.feeLamports,
    proposal.sourceBalanceLamports,
    proposal.feePayerBalanceLamports,
    proposal.nonceBalanceLamports,
    proposal.nonceRentMinimumLamports,
    proposal.slot,
    proposal.messageBase64,
    proposal.unsignedTransactionBase64,
    proposal.requiredSigners,
    proposal.createdAt,
  ];
  return createHash("sha256")
    .update("chainpay:solana-payment-review:v1\n")
    .update(JSON.stringify(committed))
    .digest("hex");
}

export function validateSolanaPaymentProposal(value: unknown): SolanaPaymentProposal {
  const proposal = solanaPaymentProposalSchema.parse(value);
  const { reviewDigest, ...withoutDigest } = proposal;
  if (computeSolanaReviewDigest(withoutDigest) !== reviewDigest) throw new Error("Solana payment review digest is invalid");
  validateTransactionShape(proposal);
  return proposal;
}

export function verifySolanaSignatureEnvelope(
  proposalValue: unknown,
  envelopeValue: unknown,
): SolanaSignatureEnvelope {
  const proposal = validateSolanaPaymentProposal(proposalValue);
  const envelope = solanaSignatureEnvelopeSchema.parse(envelopeValue);
  if (envelope.chain !== proposal.chain || envelope.treasuryId !== proposal.treasuryId || envelope.reviewDigest !== proposal.reviewDigest) {
    throw new Error("Solana signature envelope does not match this reviewed payment");
  }
  if (!proposal.requiredSigners.includes(envelope.signer)) throw new Error("Solana signature is from an unknown signer");
  const valid = ed25519.verify(
    bs58.decode(envelope.signature),
    Buffer.from(proposal.messageBase64, "base64"),
    bs58.decode(envelope.signer),
    { zip215: false },
  );
  if (!valid) throw new Error("Solana signature is invalid for the reviewed message");
  return envelope;
}

export function assembleSignedSolanaTransaction(
  proposalValue: unknown,
  envelopeValues: unknown[],
): { proposal: SolanaPaymentProposal; wireBytes: Uint8Array; firstSignature: string } {
  const proposal = validateSolanaPaymentProposal(proposalValue);
  const envelopes = envelopeValues.map((value) => verifySolanaSignatureEnvelope(proposal, value));
  if (new Set(envelopes.map((item) => item.signer)).size !== envelopes.length) throw new Error("Duplicate Solana signer envelope");
  if (envelopes.length !== proposal.requiredSigners.length || proposal.requiredSigners.some((signer) => !envelopes.some((item) => item.signer === signer))) {
    throw new Error("All required Solana signatures have not been collected");
  }
  if (envelopes.map((item) => item.signer).join("\n") !== proposal.requiredSigners.join("\n")) {
    throw new Error("Solana signatures are not in canonical signer order");
  }
  const transaction = Transaction.from(Buffer.from(proposal.unsignedTransactionBase64, "base64"));
  for (const envelope of envelopes) transaction.addSignature(new PublicKey(envelope.signer), Buffer.from(bs58.decode(envelope.signature)));
  if (!transaction.verifySignatures(true)) throw new Error("Solana transaction signature verification failed");
  const wireBytes = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
  if (wireBytes.length > MAX_SOLANA_TRANSACTION_BYTES) throw new Error("Solana transaction exceeds the wire-size limit");
  const first = transaction.signature;
  if (!first) throw new Error("Solana fee-payer signature is missing");
  return { proposal, wireBytes, firstSignature: bs58.encode(first) };
}

function validateTransactionShape(proposal: SolanaPaymentProposal): void {
  const bytes = Buffer.from(proposal.unsignedTransactionBase64, "base64");
  if (bytes.length > MAX_SOLANA_TRANSACTION_BYTES) throw new Error("Solana transaction exceeds the wire-size limit");
  const transaction = Transaction.from(bytes);
  if (transaction.instructions.length !== 2) throw new Error("Solana payment transaction must contain exactly two instructions");
  if (SystemInstruction.decodeInstructionType(transaction.instructions[0]!) !== "AdvanceNonceAccount") throw new Error("AdvanceNonceAccount must be the first instruction");
  if (SystemInstruction.decodeInstructionType(transaction.instructions[1]!) !== "Transfer") throw new Error("System transfer must be the only payment instruction");
  const advance = SystemInstruction.decodeNonceAdvance(transaction.instructions[0]!);
  const transfer = SystemInstruction.decodeTransfer(transaction.instructions[1]!);
  if (!advance.noncePubkey.equals(new PublicKey(proposal.nonceAccount)) || !advance.authorizedPubkey.equals(new PublicKey(proposal.nonceAuthority))) {
    throw new Error("Solana nonce instruction does not match the review");
  }
  if (!transfer.fromPubkey.equals(new PublicKey(proposal.source)) || !transfer.toPubkey.equals(new PublicKey(proposal.destination)) || BigInt(transfer.lamports) !== BigInt(proposal.amountLamports)) {
    throw new Error("Solana transfer instruction does not match the review");
  }
  if (transaction.recentBlockhash !== proposal.durableNonce || !transaction.feePayer?.equals(new PublicKey(proposal.feePayer))) {
    throw new Error("Solana message nonce or fee payer does not match the review");
  }
  if (Buffer.compare(transaction.serializeMessage(), Buffer.from(proposal.messageBase64, "base64")) !== 0) throw new Error("Solana message bytes do not match the review");
  const requiredSigners = deriveRequiredSigners(transaction);
  if (requiredSigners.join("\n") !== proposal.requiredSigners.join("\n")) throw new Error("Solana required signer order does not match the review");
  if (transaction.signatures.some((entry) => entry.signature !== null)) throw new Error("Unsigned Solana proposal contains signatures");
}

function deriveRequiredSigners(transaction: Transaction): string[] {
  const message = transaction.compileMessage();
  return message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
}

function canonicalU64(value: string, allowZero: boolean): string {
  if (!DECIMAL.test(value)) throw new Error("Lamports must be canonical decimal integer text");
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > U64_MAX) throw new Error("Lamports are outside the supported u64 range");
  return parsed.toString();
}

function canonicalAddress(value: string): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  } catch { return false; }
}

function canonicalSignature(value: string): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 64 && bs58.encode(decoded) === value;
  } catch { return false; }
}

function canonicalBase64(value: string): boolean {
  try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
}

export function isOnCurveSolanaAddress(address: string): boolean {
  try { return PublicKey.isOnCurve(new PublicKey(address).toBytes()); } catch { return false; }
}

export function validateSolanaPaymentChain(value: unknown): value is SolanaChain {
  return value === "sol:mainnet" || value === "sol:devnet";
}
