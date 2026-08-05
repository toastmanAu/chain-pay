import { useEffect } from "react";
import { solanaBridge } from "@/lib/chains/sol/ipc";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";
import { postFinalizedSolanaPayment } from "./solana-accounting";

const checkingByTreasury = new Map<string, Promise<void>>();

async function runCheck(treasuryId: string): Promise<void> {
  let record = useSolanaPaymentsStore.getState().records[treasuryId];
  if (!record?.receipt) return;

  try {
    const status = await solanaBridge().transactionStatus({
      chain: record.proposal.chain,
      signature: record.receipt.signature,
    });
    useSolanaPaymentsStore.getState().updateTransactionState(treasuryId, status.state);
  } catch (error) {
    useSolanaPaymentsStore.getState().fail(treasuryId, "Payment status is temporarily unavailable; the last known state was preserved");
    if (record.proposal.version === 2 && record.accountingState === "awaiting_finalization") {
      useSolanaPaymentsStore.getState().finalizationFailed(treasuryId, message(error));
    }
    return;
  }

  record = useSolanaPaymentsStore.getState().records[treasuryId];
  if (!record?.receipt || record.reconciliationRequired) return;
  if (record.proposal.version === 2 && record.transactionState === "finalized" &&
      record.accountingState === "awaiting_finalization") {
    try {
      const response = await solanaBridge().paymentFinalizedEvidence({
        chain: record.proposal.chain,
        treasuryId,
        proposal: record.proposal,
        receipt: record.receipt,
        signatures: record.signatures,
      });
      useSolanaPaymentsStore.getState().acceptFinalizedEvidence(treasuryId, response.evidence);
    } catch (error) {
      useSolanaPaymentsStore.getState().finalizationFailed(treasuryId, message(error));
      return;
    }
  }

  record = useSolanaPaymentsStore.getState().records[treasuryId];
  if (record?.accountingState === "ready") await postFinalizedSolanaPayment(treasuryId);
}

export function checkSolanaPaymentFinalization(treasuryId: string): Promise<void> {
  const active = checkingByTreasury.get(treasuryId);
  if (active) return active;
  const checking = runCheck(treasuryId).finally(() => {
    if (checkingByTreasury.get(treasuryId) === checking) checkingByTreasury.delete(treasuryId);
  });
  checkingByTreasury.set(treasuryId, checking);
  return checking;
}

export function syncSolanaPaymentsToAccounting(): void {
  for (const [treasuryId, record] of Object.entries(useSolanaPaymentsStore.getState().records)) {
    if (record.receipt) void checkSolanaPaymentFinalization(treasuryId);
  }
}

/** Keeps submitted Solana payments progressing even when their workflow page is closed. */
export function useSolanaFinalizationToAccounting(): void {
  useEffect(() => {
    syncSolanaPaymentsToAccounting();
    const unsubscribe = useSolanaPaymentsStore.subscribe(syncSolanaPaymentsToAccounting);
    const interval = globalThis.setInterval(syncSolanaPaymentsToAccounting, 20_000);
    return () => {
      unsubscribe();
      globalThis.clearInterval(interval);
    };
  }, []);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Solana finalization check failed";
}
