import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingTx } from "@chain-pay/shared";
import { canonicalSafeTxHash, serializeSafePayment, type SafePaymentPayload } from "@/lib/chains/evm/safe";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";

const postJournal = vi.fn();
vi.mock("./ipc", () => ({ postJournal: (...args: unknown[]) => postJournal(...args) }));

import { buildConfirmedSafePaymentRecord, postConfirmedSafePayment } from "./evm-safe-accounting";

const payload: SafePaymentPayload = {
  schemaVersion: 1,
  chainId: 11155111,
  safeAddress: "0x1234567890123456789012345678901234567890",
  safeVersion: "1.4.1",
  tx: {
    to: "0x2222222222222222222222222222222222222222",
    value: "10000000000000000",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 4,
  },
};

function confirmed(): PendingTx {
  return {
    id: "safe-payment-1",
    treasuryId: "safe-1",
    chain: "evm:11155111",
    state: "confirmed",
    signingDigest: canonicalSafeTxHash(payload),
    outputs: [{ to: payload.tx.to, amount: { asset: "ETH", value: payload.tx.value, decimals: 18 } }],
    payloadJson: serializeSafePayment(payload),
    signatures: [],
    broadcastedHash: `0x${"cd".repeat(32)}`,
    confirmedBlockNumber: "7123456",
    confirmedAt: "2026-08-01T02:40:00.000Z",
    executorAddress: "0x1111111111111111111111111111111111111111",
    receiptGasUsed: "100000",
    receiptEffectiveGasPriceWei: "2000000000",
    receiptGasFeeWei: "200000000000000",
    accounting: { payeeId: "vendor-1", fiat: { currency: "USD", minor: 2550n } },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T02:40:00.000Z",
  };
}

beforeEach(() => {
  usePendingTransactionsStore.setState({ transactions: [confirmed()] });
  postJournal.mockReset();
});

describe("Safe confirmation accounting", () => {
  it("builds an immutable EVM source with both hashes and executor-paid receipt gas", () => {
    expect(buildConfirmedSafePaymentRecord(confirmed())).toEqual(
      expect.objectContaining({
        batchId: "safe-payment-1",
        chain: "evm:11155111",
        txHash: `0x${"cd".repeat(32)}`,
        lines: [expect.objectContaining({ payeeId: "vendor-1", crypto: { asset: "ETH", value: 10_000_000_000_000_000n, decimals: 18 } })],
        evm: expect.objectContaining({
          safeTxHash: canonicalSafeTxHash(payload),
          outerTxHash: `0x${"cd".repeat(32)}`,
          safeAddress: payload.safeAddress,
          recipientAddress: payload.tx.to,
          executorAddress: "0x1111111111111111111111111111111111111111",
          confirmedBlockNumber: "7123456",
          gasUsed: "100000",
          effectiveGasPriceWei: "2000000000",
          gasFeeWei: "200000000000000",
          gasPayer: "executor",
        }),
      }),
    );
  });

  it("posts once and records both backend identities", async () => {
    postJournal.mockResolvedValue({
      jeName: "ACC-JV-1",
      recordName: "BATCH-1",
      idempotent: false,
      recordIdempotent: false,
    });
    await postConfirmedSafePayment("safe-payment-1");
    expect(postJournal).toHaveBeenCalledTimes(1);
    expect(usePendingTransactionsStore.getState().findById("safe-payment-1")).toMatchObject({
      state: "posted",
      journalEntryName: "ACC-JV-1",
      accountingRecordName: "BATCH-1",
    });
    await postConfirmedSafePayment("safe-payment-1");
    expect(postJournal).toHaveBeenCalledTimes(1);
  });

  it("lands in post_failed and retries without touching chain execution", async () => {
    postJournal.mockRejectedValueOnce(new Error("Frappe unavailable")).mockResolvedValueOnce({
      jeName: "ACC-JV-1",
      recordName: "BATCH-1",
      idempotent: true,
      recordIdempotent: true,
    });
    await postConfirmedSafePayment("safe-payment-1");
    expect(usePendingTransactionsStore.getState().findById("safe-payment-1")).toMatchObject({
      state: "post_failed",
      postError: "Frappe unavailable",
    });
    await postConfirmedSafePayment("safe-payment-1");
    expect(postJournal).toHaveBeenCalledTimes(2);
    expect(usePendingTransactionsStore.getState().findById("safe-payment-1")?.state).toBe("posted");
  });

  it("rejects receipt metadata whose gas fee was altered", () => {
    expect(() => buildConfirmedSafePaymentRecord({ ...confirmed(), receiptGasFeeWei: "1" })).toThrow(
      "receipt gas evidence is inconsistent",
    );
  });
});
