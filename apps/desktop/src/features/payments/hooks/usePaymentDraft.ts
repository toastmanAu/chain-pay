import { useState } from "react";
import type { RecipientRow } from "../payment-draft";

const DEFAULT_FEE_RATE = 1000n;

/**
 * The editable half of a payment: which treasury is spending, who is being
 * paid, the fee rate and the operator's label.
 *
 * A thin `useState` grouping only — no validation, no derivation. `reset()`
 * deliberately does NOT live here: "Send another" clears the tx lifecycle and
 * leaves the draft rows intact (see the BUG PIN in PayPanel.test.tsx).
 *
 * `initialTreasuryId` is read on the first render only, like any `useState`
 * initial value.
 */
export function usePaymentDraft(initialTreasuryId: string) {
  const [treasuryId, setTreasuryId] = useState<string>(initialTreasuryId);
  const [recipients, setRecipients] = useState<RecipientRow[]>([
    { address: "", amountCkb: "" },
  ]);
  const [feeRate, setFeeRate] = useState(DEFAULT_FEE_RATE.toString());
  const [label, setLabel] = useState("");

  return { treasuryId, setTreasuryId, recipients, setRecipients, feeRate, setFeeRate, label, setLabel };
}
