import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingTx } from "@chain-pay/shared";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";

const postConfirmedSafePayment = vi.fn();
vi.mock("./evm-safe-accounting", () => ({
  postConfirmedSafePayment: (...args: unknown[]) => postConfirmedSafePayment(...args),
}));

import { syncConfirmedSafePaymentsToAccounting } from "./use-safe-confirmation-to-accounting";

function item(id: string, state: PendingTx["state"], chain: PendingTx["chain"] = "evm:11155111"): PendingTx {
  return {
    id,
    treasuryId: "safe-1",
    chain,
    state,
    signingDigest: `0x${"ab".repeat(32)}`,
    outputs: [],
    payloadJson: "{}",
    signatures: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  postConfirmedSafePayment.mockReset();
});

describe("syncConfirmedSafePaymentsToAccounting", () => {
  it("posts only confirmed Sepolia Safe payments", () => {
    usePendingTransactionsStore.setState({
      transactions: [
        item("confirmed", "confirmed"),
        item("posting", "posting"),
        item("failed", "post_failed"),
        item("ckb", "confirmed", "ckb:testnet"),
      ],
    });
    syncConfirmedSafePaymentsToAccounting();
    expect(postConfirmedSafePayment).toHaveBeenCalledTimes(1);
    expect(postConfirmedSafePayment).toHaveBeenCalledWith("confirmed");
  });
});
