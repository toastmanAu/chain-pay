import { useState } from "react";
import type { PaymentSkeleton } from "@/lib/chains/ckb/tx-builder";
import type { SignatureRow } from "../payment-draft";

/**
 * `"broadcast-ready"` is never assigned by anything — dead state kept because
 * two render gates still test for it. Do not remove it without also removing
 * those branches.
 */
export type Phase = "draft" | "packet-ready" | "broadcast-ready" | "broadcasted";

/**
 * The ephemeral transaction lifecycle for one payment: the built skeleton, the
 * encoded packet, the collected signature slots, the broadcast result and the
 * id of the PayrollBatch (if any) this draft is attached to.
 *
 * A thin `useState` grouping only — every transition is still driven from
 * PayPanel.
 */
export function usePaymentLifecycle() {
  const [phase, setPhase] = useState<Phase>("draft");
  const [skeleton, setSkeleton] = useState<PaymentSkeleton | null>(null);
  const [packetJson, setPacketJson] = useState<string>("");
  const [sigs, setSigs] = useState<SignatureRow[]>([]);
  const [broadcastedTxHash, setBroadcastedTxHash] = useState<string | null>(null);
  // Active batch id for this draft. Set when build succeeds with payee-sourced
  // rows; advances state on broadcast. null = manual one-off payment, no batch
  // lifecycle attached.
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  /**
   * Return the tx lifecycle to a fresh draft.
   *
   * Deliberately narrow: this is exactly what the inline "Send another" /
   * treasury-switch handler cleared before the hook existed. It does NOT clear
   * `recipients`, `feeRate` or `label` — an operator clicking "Send another" is
   * one Build click away from repeating the payment they just made. That is a
   * real defect, pinned by a BUG PIN test in PayPanel.test.tsx; do not "fix" it
   * here. The shell still clears `error` and the FX snapshot alongside this
   * call, because those states live outside this hook.
   */
  const reset = () => {
    setPhase("draft");
    setSkeleton(null);
    setPacketJson("");
    setSigs([]);
    setBroadcastedTxHash(null);
    setActiveBatchId(null);
  };

  return {
    phase,
    setPhase,
    skeleton,
    setSkeleton,
    packetJson,
    setPacketJson,
    sigs,
    setSigs,
    broadcastedTxHash,
    setBroadcastedTxHash,
    activeBatchId,
    setActiveBatchId,
    reset,
  };
}
