import type { ConfirmedPaymentRecord, SolanaPaymentRecord } from "@chain-pay/shared";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";
import { postJournal } from "./ipc";

const postingByTreasury = new Map<string, Promise<void>>();

export function buildFinalizedSolanaPaymentRecord(record: SolanaPaymentRecord): ConfirmedPaymentRecord {
  const { proposal, receipt, finalizedEvidence: evidence } = record;
  if (proposal.version !== 2) throw new Error("legacy Solana payments have no committed accounting intent");
  if (!receipt || !evidence || record.transactionState !== "finalized") {
    throw new Error("Solana payment is missing finalized evidence");
  }
  if (record.reconciliationRequired || record.accountingState === "reconciliation_required") {
    throw new Error("Solana payment requires reconciliation before accounting can continue");
  }
  if (record.accountingState !== "ready" && record.accountingState !== "post_failed") {
    throw new Error("Solana payment accounting is not ready to post");
  }

  const expected: Array<[unknown, unknown]> = [
    [evidence.chain, proposal.chain], [evidence.reviewDigest, proposal.reviewDigest],
    [evidence.signature, receipt.signature], [evidence.messageBase64, proposal.messageBase64],
    [evidence.source, proposal.source], [evidence.destination, proposal.destination],
    [evidence.amountLamports, proposal.amountLamports], [evidence.feePayer, proposal.feePayer],
    [evidence.feeLamports, proposal.feeLamports], [evidence.nonceAccount, proposal.nonceAccount],
    [evidence.nonceAuthority, proposal.nonceAuthority], [evidence.durableNonce, proposal.durableNonce],
  ];
  if (evidence.version !== 1 || evidence.transactionVersion !== "legacy" ||
      evidence.feePayerPolicy !== "transaction_fee_payer" || expected.some(([actual, wanted]) => actual !== wanted)) {
    throw new Error("finalized Solana evidence no longer matches the immutable review");
  }

  const amountLamports = canonicalInteger(evidence.amountLamports, false, "amount");
  canonicalInteger(evidence.feeLamports, true, "fee");
  const fiatMinor = canonicalInteger(proposal.accounting.fiat.minor, false, "accounting value");
  const payeeId = proposal.accounting.payeeId.trim();
  if (!payeeId || payeeId !== proposal.accounting.payeeId || payeeId.length > 140) {
    throw new Error("Solana payment has an invalid committed payee reference");
  }

  return {
    batchId: `solana:${proposal.reviewDigest}`,
    sourceType: "send",
    label: `Solana payment ${proposal.reviewDigest.slice(0, 12)}`,
    chain: proposal.chain,
    txHash: receipt.signature,
    confirmedAt: evidence.finalizedAt,
    lines: [{
      payeeId,
      fiat: { currency: "USD", minor: fiatMinor },
      crypto: { asset: "SOL", value: amountLamports, decimals: 9 },
    }],
    solana: {
      reviewDigest: proposal.reviewDigest,
      sourceAddress: evidence.source,
      recipientAddress: evidence.destination,
      feePayerAddress: evidence.feePayer,
      nonceAccount: evidence.nonceAccount,
      nonceAuthority: evidence.nonceAuthority,
      durableNonce: evidence.durableNonce,
      finalizedSlot: evidence.slot,
      amountLamports: evidence.amountLamports,
      feeLamports: evidence.feeLamports,
      feePayerPolicy: evidence.feePayerPolicy,
      messageBase64: evidence.messageBase64,
    },
  };
}

async function runPost(treasuryId: string): Promise<void> {
  const store = useSolanaPaymentsStore.getState();
  const record = store.records[treasuryId];
  if (!record || (record.accountingState !== "ready" && record.accountingState !== "post_failed")) return;

  let source: ConfirmedPaymentRecord;
  try {
    source = buildFinalizedSolanaPaymentRecord(record);
    store.beginAccountingPost(treasuryId);
  } catch (error) {
    if (record.accountingState === "ready" || record.accountingState === "post_failed") {
      try {
        store.beginAccountingPost(treasuryId);
        useSolanaPaymentsStore.getState().markAccountingPostFailed(treasuryId, errorMessage(error));
      } catch { /* A reconciliation transition won the race; keep it authoritative. */ }
    }
    return;
  }

  try {
    const result = await postJournal(source);
    useSolanaPaymentsStore.getState().markAccountingPosted(treasuryId, result.jeName, result.recordName);
  } catch (error) {
    useSolanaPaymentsStore.getState().markAccountingPostFailed(treasuryId, errorMessage(error));
  }
}

/** Idempotent and single-flight. This function never submits or rebuilds a Solana transaction. */
export function postFinalizedSolanaPayment(treasuryId: string): Promise<void> {
  const active = postingByTreasury.get(treasuryId);
  if (active) return active;
  const posting = runPost(treasuryId).finally(() => {
    if (postingByTreasury.get(treasuryId) === posting) postingByTreasury.delete(treasuryId);
  });
  postingByTreasury.set(treasuryId, posting);
  return posting;
}

function canonicalInteger(value: string, zeroAllowed: boolean, label: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Solana ${label} is not canonical`);
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n || (zeroAllowed ? parsed < 0n : parsed <= 0n)) {
    throw new Error(`Solana ${label} is out of range`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown accounting posting error";
}
