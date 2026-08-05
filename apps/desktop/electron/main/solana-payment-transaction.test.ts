import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves-v2/ed25519.js";
import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import type { SolanaPaymentInspection, SolanaSignatureEnvelope } from "@chain-pay/shared";
import {
  assembleSignedSolanaTransaction,
  buildSolanaPaymentTransaction,
  computeSolanaReviewDigest,
  validateSolanaPaymentProposal,
  validateFinalizedSolanaTransaction,
  solanaReviewApprovalBytes,
  verifySolanaSignatureEnvelope,
} from "./solana-payment-transaction";

const source = signer(1);
const nonceAuthority = signer(2);
const feePayer = signer(3);
const destination = signer(4);
const nonceAccount = signer(5).address;
const durableNonce = signer(6).address;

const inspection: SolanaPaymentInspection = {
  chain: "sol:devnet",
  source: source.address,
  nonceAccount,
  nonceAuthority: nonceAuthority.address,
  feePayer: feePayer.address,
  sourceBalanceLamports: "9007199254740993",
  nonceBalanceLamports: "1500000",
  nonceRentMinimumLamports: "1447680",
  feePayerBalanceLamports: "100000",
  durableNonce,
  slot: "9007199254740994",
};

describe("canonical durable-nonce native SOL transaction", () => {
  it("builds exactly nonce-advance then transfer and derives actual signer order", () => {
    const proposal = buildSolanaPaymentTransaction({
      inspection,
      treasuryId: "sol-1",
      destination: destination.address,
      amountLamports: "9007199254740000",
      feeLamports: "15000",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    expect(proposal.requiredSigners[0]).toBe(feePayer.address);
    expect(proposal.requiredSigners).toEqual(expect.arrayContaining([source.address, nonceAuthority.address]));
    expect(new Set(proposal.requiredSigners).size).toBe(3);
    expect(validateSolanaPaymentProposal(proposal)).toEqual(proposal);
    const parsed = Transaction.from(Buffer.from(proposal.unsignedTransactionBase64, "base64"));
    expect(parsed.instructions).toHaveLength(2);
    expect(parsed.recentBlockhash).toBe(durableNonce);
  });

  it("digest-binds version-2 accounting intent without changing the Solana message bytes", () => {
    const common = { inspection, treasuryId: "sol-1", destination: destination.address, amountLamports: "42", feeLamports: "15000", createdAt: "2026-08-05T00:00:00.000Z" };
    const legacy = buildSolanaPaymentTransaction(common);
    const accounting = { payeeId: "vendor-17", fiat: { currency: "USD" as const, minor: "2500" } };
    const current = buildSolanaPaymentTransaction({ ...common, accounting });
    expect(legacy.version).toBe(1);
    expect(current).toMatchObject({ version: 2, accounting });
    expect(current.messageBase64).toBe(legacy.messageBase64);
    expect(current.unsignedTransactionBase64).toBe(legacy.unsignedTransactionBase64);
    expect(current.reviewDigest).not.toBe(legacy.reviewDigest);
    expect(validateSolanaPaymentProposal(current)).toEqual(current);
    expect(() => validateSolanaPaymentProposal({ ...current, accounting: { ...accounting, payeeId: "attacker" } })).toThrow(/digest/i);
    const currentEnvelope = {
      format: "chainpay-solana-signature-v2" as const,
      chain: current.chain,
      treasuryId: current.treasuryId,
      reviewDigest: current.reviewDigest,
      signer: feePayer.address,
      signature: bs58.encode(ed25519.sign(Buffer.from(current.messageBase64, "base64"), feePayer.secret)),
      reviewSignature: bs58.encode(ed25519.sign(solanaReviewApprovalBytes(current.reviewDigest), feePayer.secret)),
    };
    expect(verifySolanaSignatureEnvelope(current, currentEnvelope)).toEqual(currentEnvelope);
    expect(() => verifySolanaSignatureEnvelope(current, { ...currentEnvelope, reviewSignature: bs58.encode(new Uint8Array(64).fill(8)) })).toThrow(/accounting-bound/i);
    const { reviewSignature: _reviewSignature, ...transactionOnly } = currentEnvelope;
    expect(() => verifySolanaSignatureEnvelope(current, { ...transactionOnly, format: "chainpay-solana-signature-v1" })).toThrow(/version/i);
  });

  it("verifies signature-only envelopes and assembles the exact reviewed wire transaction", () => {
    const proposal = buildSolanaPaymentTransaction({ inspection, treasuryId: "sol-1", destination: destination.address, amountLamports: "42", feeLamports: "15000" });
    const signers = new Map([source, nonceAuthority, feePayer].map((item) => [item.address, item]));
    const envelopes = proposal.requiredSigners.map((address) => envelope(proposal, signers.get(address)!));
    for (const item of envelopes) expect(verifySolanaSignatureEnvelope(proposal, item)).toEqual(item);
    const assembled = assembleSignedSolanaTransaction(proposal, envelopes);
    expect(assembled.firstSignature).toBe(envelopes[0]?.signature);
    expect(Transaction.from(assembled.wireBytes).verifySignatures()).toBe(true);
    const receipt = { signature: assembled.firstSignature, reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:01:00.000Z", alreadySubmitted: false };
    expect(validateFinalizedSolanaTransaction(proposal, receipt, Buffer.from(assembled.wireBytes).toString("base64"))).toMatchObject({ signature: assembled.firstSignature });
    expect(() => validateFinalizedSolanaTransaction(proposal, { ...receipt, signature: bs58.encode(new Uint8Array(64).fill(8)) }, Buffer.from(assembled.wireBytes).toString("base64"))).toThrow(/receipt/i);
  });

  it("rejects digest, message, signer, signature, duplicate, and signer-order tampering", () => {
    const proposal = buildSolanaPaymentTransaction({ inspection, treasuryId: "sol-1", destination: destination.address, amountLamports: "42", feeLamports: "15000" });
    const signers = new Map([source, nonceAuthority, feePayer].map((item) => [item.address, item]));
    const envelopes = proposal.requiredSigners.map((address) => envelope(proposal, signers.get(address)!));
    expect(() => validateSolanaPaymentProposal({ ...proposal, amountLamports: "43" })).toThrow(/digest/i);
    expect(() => verifySolanaSignatureEnvelope(proposal, { ...envelopes[0], treasuryId: "other" })).toThrow(/does not match/i);
    expect(() => verifySolanaSignatureEnvelope(proposal, { ...envelopes[0], chain: "sol:mainnet" })).toThrow(/does not match/i);
    expect(() => verifySolanaSignatureEnvelope(proposal, { ...envelopes[0], signer: destination.address })).toThrow(/unknown signer/i);
    expect(() => verifySolanaSignatureEnvelope(proposal, { ...envelopes[0], signature: bs58.encode(new Uint8Array(64).fill(9)) })).toThrow(/invalid/i);
    expect(() => verifySolanaSignatureEnvelope(proposal, { ...envelopes[0], privateKey: "must-not-cross" })).toThrow();
    expect(() => validateSolanaPaymentProposal({ ...proposal, messageBase64: "A".repeat(4_004) })).toThrow();
    expect(() => assembleSignedSolanaTransaction(proposal, [envelopes[0]!, envelopes[0]!, envelopes[2]!])).toThrow(/duplicate/i);
    expect(() => assembleSignedSolanaTransaction(proposal, [...envelopes].reverse())).toThrow(/canonical signer order/i);
  });

  it("enforces nonce advance as instruction zero even when a tampered review digest is recomputed", () => {
    const proposal = buildSolanaPaymentTransaction({ inspection, treasuryId: "sol-1", destination: destination.address, amountLamports: "42", feeLamports: "15000" });
    const transaction = Transaction.from(Buffer.from(proposal.unsignedTransactionBase64, "base64"));
    transaction.instructions.reverse();
    const { reviewDigest: _ignored, ...fields } = proposal;
    const altered = {
      ...fields,
      messageBase64: Buffer.from(transaction.serializeMessage()).toString("base64"),
      unsignedTransactionBase64: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"),
    };
    expect(() => validateSolanaPaymentProposal({ ...altered, reviewDigest: computeSolanaReviewDigest(altered) })).toThrow(/first instruction/i);
  });
});

function signer(fill: number): { secret: Uint8Array; address: string } {
  const secret = new Uint8Array(32).fill(fill);
  return { secret, address: bs58.encode(ed25519.getPublicKey(secret)) };
}

function envelope(
  proposal: ReturnType<typeof buildSolanaPaymentTransaction>,
  item: { secret: Uint8Array; address: string },
): SolanaSignatureEnvelope {
  return {
    format: "chainpay-solana-signature-v1",
    chain: proposal.chain,
    treasuryId: proposal.treasuryId,
    reviewDigest: proposal.reviewDigest,
    signer: item.address,
    signature: bs58.encode(ed25519.sign(Buffer.from(proposal.messageBase64, "base64"), item.secret)),
  };
}
