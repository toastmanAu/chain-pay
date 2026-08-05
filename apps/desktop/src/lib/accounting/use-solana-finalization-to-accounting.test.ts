// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaFinalizedPaymentEvidence, SolanaPaymentRecord } from "@chain-pay/shared";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";

const postFinalized = vi.fn();
vi.mock("./solana-accounting", () => ({ postFinalizedSolanaPayment: (...args: unknown[]) => postFinalized(...args) }));

import { checkSolanaPaymentFinalization } from "./use-solana-finalization-to-accounting";

function record(): SolanaPaymentRecord {
  return {
    treasuryId: "sol-1", state: "submitted",
    proposal: {
      version: 2, chain: "sol:devnet", treasuryId: "sol-1", source: "source", destination: "destination",
      nonceAccount: "nonce", nonceAuthority: "authority", feePayer: "payer", sourceBalanceLamports: "10",
      nonceBalanceLamports: "10", nonceRentMinimumLamports: "1", feePayerBalanceLamports: "10", durableNonce: "durable",
      slot: "10", amountLamports: "1", feeLamports: "2", messageBase64: "bQ==", unsignedTransactionBase64: "dA==",
      requiredSigners: ["source"], reviewDigest: "a".repeat(64), createdAt: "2026-08-05T00:00:00.000Z",
      accounting: { payeeId: "vendor", fiat: { currency: "USD", minor: "100" } },
    },
    signatures: [{ format: "chainpay-solana-signature-v2", chain: "sol:devnet", treasuryId: "sol-1", reviewDigest: "a".repeat(64), signer: "source", signature: "sig", reviewSignature: "review-sig" }],
    receipt: { signature: "sig", reviewDigest: "a".repeat(64), submittedAt: "2026-08-05T00:01:00.000Z", alreadySubmitted: false },
    transactionState: "processed", rollbackDetected: false, accountingState: "awaiting_finalization", finalizedEvidence: null,
    accountingRecordName: null, journalEntryName: null, accountingError: null, reconciliationRequired: false,
    error: null, updatedAt: "2026-08-05T00:01:00.000Z",
  };
}

function evidence(value: SolanaPaymentRecord): SolanaFinalizedPaymentEvidence {
  const proposal = value.proposal;
  return { version: 1, chain: proposal.chain, reviewDigest: proposal.reviewDigest, signature: value.receipt!.signature,
    slot: "20", finalizedAt: "2026-08-05T00:02:00.000Z", transactionVersion: "legacy",
    messageBase64: proposal.messageBase64, signedTransactionBase64: "cw==", source: proposal.source,
    destination: proposal.destination, amountLamports: proposal.amountLamports, feePayer: proposal.feePayer,
    feeLamports: proposal.feeLamports, feePayerPolicy: "transaction_fee_payer", nonceAccount: proposal.nonceAccount,
    nonceAuthority: proposal.nonceAuthority, durableNonce: proposal.durableNonce };
}

const transactionStatus = vi.fn();
const paymentFinalizedEvidence = vi.fn();

beforeEach(() => {
  postFinalized.mockReset().mockResolvedValue(undefined);
  transactionStatus.mockReset();
  paymentFinalizedEvidence.mockReset();
  useSolanaPaymentsStore.setState({ records: { "sol-1": record() } });
  (window as unknown as { chainpay: { solana: unknown } }).chainpay = {
    solana: { transactionStatus, paymentFinalizedEvidence },
  };
});

describe("Solana finalization recovery", () => {
  it.each(["processed", "confirmed"] as const)("does not fetch evidence or post at %s", async (state) => {
    transactionStatus.mockResolvedValue({ state, slot: "11", confirmations: 1 });
    await checkSolanaPaymentFinalization("sol-1");
    expect(paymentFinalizedEvidence).not.toHaveBeenCalled();
    expect(postFinalized).not.toHaveBeenCalled();
  });

  it("accepts exact finalized evidence and queues accounting", async () => {
    const current = record();
    transactionStatus.mockResolvedValue({ state: "finalized", slot: "20", confirmations: null });
    paymentFinalizedEvidence.mockResolvedValue({ evidence: evidence(current) });
    await checkSolanaPaymentFinalization("sol-1");
    expect(paymentFinalizedEvidence).toHaveBeenCalledWith(expect.objectContaining({ treasuryId: "sol-1", receipt: current.receipt }));
    expect(useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({ transactionState: "finalized", accountingState: "ready" });
    expect(postFinalized).toHaveBeenCalledWith("sol-1");
  });

  it("turns a later finalized regression into reconciliation without reposting", async () => {
    const posted = { ...record(), transactionState: "finalized" as const, accountingState: "posted" as const,
      finalizedEvidence: evidence(record()), accountingRecordName: "BATCH-1", journalEntryName: "JE-1" };
    useSolanaPaymentsStore.setState({ records: { "sol-1": posted } });
    transactionStatus.mockResolvedValue({ state: "unknown", slot: null, confirmations: null });
    await checkSolanaPaymentFinalization("sol-1");
    expect(useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({ accountingState: "reconciliation_required", accountingRecordName: "BATCH-1", journalEntryName: "JE-1" });
    expect(postFinalized).not.toHaveBeenCalled();
  });
});
