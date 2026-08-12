import { useState } from "react";
import type { FxQuote } from "@chain-pay/shared";

/**
 * FX snapshot state, lifted out of DraftForm so `handleBuild` can persist the
 * quotes it used onto the PayrollBatch record.
 *
 * A thin `useState` grouping only — the fetch/merge logic stays in PayPanel.
 * `fxSnapshot` maps CURRENCY → FxQuote (CKB-based).
 */
export function useFxSnapshot() {
  const [fxSnapshot, setFxSnapshot] = useState<Map<string, FxQuote>>(new Map());
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);

  return { fxSnapshot, setFxSnapshot, fxLoading, setFxLoading, fxError, setFxError };
}
