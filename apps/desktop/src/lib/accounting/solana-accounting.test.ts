import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaPaymentRecord } from "@chain-pay/shared";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";

const postJournal = vi.fn();
vi.mock("./ipc", () => ({ postJournal: (...args: unknown[]) => postJournal(...args) }));

import { buildFinalizedSolanaPaymentRecord, postFinalizedSolanaPayment } from "./solana-accounting";

function finalized(): SolanaPaymentRecord {
  const proposal = {
    version: 2 as const, chain: "sol:devnet" as const, treasuryId: "sol-1", source: "source",
    nonceAccount: "nonce", nonceAuthority: "authority", feePayer: "fee-payer",
    sourceBalanceLamports: "9007199254740993", nonceBalanceLamports: "1", nonceRentMinimumLamports: "1",
    feePayerBalanceLamports: "10", durableNonce: "durable", slot: "10", destination: "destination",
    amountLamports: "9007199254740993", feeLamports: "5000", messageBase64: "bWVzc2FnZQ==",
    unsignedTransactionBase64: "dHg=", requiredSigners: ["source"], reviewDigest: "a".repeat(64),
    accounting: { payeeId: "vendor-42", fiat: { currency: "USD" as const, minor: "2599" } },
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  return {
    treasuryId: "sol-1", state: "submitted", proposal, signatures: [],
    receipt: { signature: "signature", reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:01:00.000Z", alreadySubmitted: false },
    transactionState: "finalized", rollbackDetected: false, accountingState: "ready",
    finalizedEvidence: {
      version: 1, chain: proposal.chain, reviewDigest: proposal.reviewDigest, signature: "signature", slot: "20",
      finalizedAt: "2026-08-05T00:02:00.000Z", transactionVersion: "legacy", messageBase64: proposal.messageBase64,
      signedTransactionBase64: "c2lnbmVk", source: proposal.source, destination: proposal.destination,
      amountLamports: proposal.amountLamports, feePayer: proposal.feePayer, feeLamports: proposal.feeLamports,
      feePayerPolicy: "transaction_fee_payer", nonceAccount: proposal.nonceAccount,
      nonceAuthority: proposal.nonceAuthority, durableNonce: proposal.durableNonce,
    },
    accountingRecordName: null, journalEntryName: null, accountingError: null, reconciliationRequired: false,
    error: null, updatedAt: "2026-08-05T00:02:00.000Z",
  };
}

beforeEach(() => {
  postJournal.mockReset();
  useSolanaPaymentsStore.setState({ records: { "sol-1": finalized() } });
});

describe("finalized Solana accounting", () => {
  it("builds exact unsafe-range lamports and deterministic Solana metadata", () => {
    expect(buildFinalizedSolanaPaymentRecord(finalized())).toEqual(expect.objectContaining({
      batchId: `solana:${"a".repeat(64)}`, chain: "sol:devnet", txHash: "signature",
      lines: [{ payeeId: "vendor-42", fiat: { currency: "USD", minor: 2599n }, crypto: { asset: "SOL", value: 9007199254740993n, decimals: 9 } }],
      solana: expect.objectContaining({ amountLamports: "9007199254740993", feeLamports: "5000", finalizedSlot: "20" }),
    }));
  });

  it("rejects legacy, non-finalized, tampered, and reconciliation records", () => {
    const record = finalized();
    expect(() => buildFinalizedSolanaPaymentRecord({ ...record, transactionState: "confirmed" })).toThrow(/finalized evidence/);
    expect(() => buildFinalizedSolanaPaymentRecord({ ...record, finalizedEvidence: { ...record.finalizedEvidence!, feeLamports: "1" } })).toThrow(/immutable review/);
    expect(() => buildFinalizedSolanaPaymentRecord({ ...record, reconciliationRequired: true })).toThrow(/reconciliation/);
    expect(() => buildFinalizedSolanaPaymentRecord({ ...record, proposal: { ...record.proposal, version: 1 } as never })).toThrow(/legacy/);
  });

  it("posts single-flight, records both identities, and safely retries a lost response", async () => {
    let release!: () => void;
    postJournal.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ jeName: "JE-1", recordName: "BATCH-1", idempotent: false, recordIdempotent: false }); }));
    const first = postFinalizedSolanaPayment("sol-1");
    const second = postFinalizedSolanaPayment("sol-1");
    expect(postJournal).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(useSolanaPaymentsStore.getState().records["sol-1"]).toMatchObject({ accountingState: "posted", journalEntryName: "JE-1", accountingRecordName: "BATCH-1" });

    useSolanaPaymentsStore.setState({ records: { "sol-1": { ...finalized(), accountingState: "post_failed" } } });
    postJournal.mockResolvedValueOnce({ jeName: "JE-1", recordName: "BATCH-1", idempotent: true, recordIdempotent: true });
    await postFinalizedSolanaPayment("sol-1");
    expect(postJournal).toHaveBeenCalledTimes(2);
  });
});
