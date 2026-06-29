import { useEffect } from "react";
import { useSendsStore } from "@/stores/sends";
import { postSendJournal } from "./send-journal";

/**
 * Side-effect: post a JE for every send in `confirmed` state. Idempotent via
 * the confirmed→posting guard inside postSendJournal.
 * Note: `post_failed` retries happen via the SendHistory Retry button calling
 * postSendJournal(id) directly — mirrors the payroll batch Retry pattern.
 */
export function syncConfirmedSendsToAccounting(): void {
  for (const s of useSendsStore.getState().sends) {
    if (s.state !== "confirmed") continue;
    void postSendJournal(s.id);
  }
}

/** React hook: run on mount and whenever the sends store changes. */
export function useSendConfirmationToAccounting(): void {
  useEffect(() => {
    syncConfirmedSendsToAccounting();
    const unsub = useSendsStore.subscribe(() => syncConfirmedSendsToAccounting());
    return unsub;
  }, []);
}
