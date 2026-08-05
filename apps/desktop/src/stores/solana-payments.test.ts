import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaPaymentProposal, SolanaSignatureEnvelope } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

const signers = ["signer-fee", "signer-source", "signer-nonce"];

function proposal(): SolanaPaymentProposal {
  return {
    version: 1,
    chain: "sol:devnet",
    treasuryId: "sol-1",
    source: "source",
    destination: "destination",
    nonceAccount: "nonce-account",
    nonceAuthority: "signer-nonce",
    feePayer: "signer-fee",
    sourceBalanceLamports: "9007199254740993",
    nonceBalanceLamports: "1500000",
    nonceRentMinimumLamports: "1447680",
    feePayerBalanceLamports: "100000",
    durableNonce: "nonce-value",
    slot: "9007199254740994",
    amountLamports: "42",
    feeLamports: "5000",
    messageBase64: "bWVzc2FnZQ==",
    unsignedTransactionBase64: "dHJhbnNhY3Rpb24=",
    requiredSigners: signers,
    reviewDigest: "a".repeat(64),
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}

function envelope(signer: string): SolanaSignatureEnvelope {
  return {
    format: "chainpay-solana-signature-v1",
    chain: "sol:devnet",
    treasuryId: "sol-1",
    reviewDigest: "a".repeat(64),
    signer,
    signature: `signature-${signer}`,
  };
}

describe("Solana payment persistence", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    vi.resetModules();
  });
  afterEach(() => { delete (globalThis as { localStorage?: Storage }).localStorage; });

  it("persists partial signatures in canonical signer order and rejects replacement attempts", async () => {
    const { useSolanaPaymentsStore } = await import("./solana-payments");
    const store = useSolanaPaymentsStore.getState();
    store.acceptProposal("sol-1", proposal());
    store.addVerifiedSignature("sol-1", envelope(signers[2]!));
    store.addVerifiedSignature("sol-1", envelope(signers[0]!));
    expect(useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({
      state: "collecting_signatures",
      signatures: [{ signer: signers[0] }, { signer: signers[2] }],
    });
    expect(() => useSolanaPaymentsStore.getState().addVerifiedSignature("sol-1", envelope(signers[0]!))).toThrow(/already/i);
    expect(() => useSolanaPaymentsStore.getState().addVerifiedSignature("sol-1", { ...envelope("unknown"), signer: "unknown" })).toThrow(/unknown/i);

    vi.resetModules();
    const restarted = await import("./solana-payments");
    expect(restarted.useSolanaPaymentsStore.getState().records["sol-1"]?.signatures.map((item) => item.signer))
      .toEqual([signers[0], signers[2]]);
  });

  it("recovers interrupted submission, persists an idempotent receipt, and flags status rollback", async () => {
    const first = await import("./solana-payments");
    first.useSolanaPaymentsStore.getState().acceptProposal("sol-1", proposal());
    for (const signer of signers) first.useSolanaPaymentsStore.getState().addVerifiedSignature("sol-1", envelope(signer));
    first.useSolanaPaymentsStore.getState().beginSubmit("sol-1");

    vi.resetModules();
    const restarted = await import("./solana-payments");
    expect(restarted.useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({
      state: "ready",
      error: "The previous submission was interrupted; revalidation is required",
    });
    const receipt = { signature: "tx-signature", reviewDigest: "a".repeat(64), submittedAt: "2026-08-05T01:00:00.000Z", alreadySubmitted: true } as const;
    restarted.useSolanaPaymentsStore.getState().acceptReceipt("sol-1", receipt);
    restarted.useSolanaPaymentsStore.getState().acceptReceipt("sol-1", receipt);
    restarted.useSolanaPaymentsStore.getState().updateTransactionState("sol-1", "finalized");
    restarted.useSolanaPaymentsStore.getState().updateTransactionState("sol-1", "unknown");
    expect(restarted.useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({
      state: "submitted",
      receipt,
      transactionState: "unknown",
      rollbackDetected: true,
    });
  });

  it("returns an interrupted provider submission to a re-confirmable state without dropping signatures", async () => {
    const { useSolanaPaymentsStore } = await import("./solana-payments");
    useSolanaPaymentsStore.getState().acceptProposal("sol-1", proposal());
    for (const signer of signers) useSolanaPaymentsStore.getState().addVerifiedSignature("sol-1", envelope(signer));
    useSolanaPaymentsStore.getState().beginSubmit("sol-1");
    useSolanaPaymentsStore.getState().submissionFailed("sol-1", "Provider unavailable");
    expect(useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({
      state: "ready",
      error: "Provider unavailable",
      signatures: [{ signer: signers[0] }, { signer: signers[1] }, { signer: signers[2] }],
      receipt: null,
    });
  });
});
