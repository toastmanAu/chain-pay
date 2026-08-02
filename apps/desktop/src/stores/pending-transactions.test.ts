import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes } from "@/lib/chains/evm/safe-owner-signature";
import { MemoryStorage } from "./test-utils/memory-storage";

const ownerAccount = privateKeyToAccount(`0x${"01".repeat(32)}`);
const otherOwnerAccount = privateKeyToAccount(`0x${"02".repeat(32)}`);
const OWNER = ownerAccount.address;
const OTHER_OWNER = otherOwnerAccount.address;
const DIGEST = `0x${"ab".repeat(32)}` as const;
const MULTISIG: EvmMultisig = {
  chain: "evm:11155111",
  address: "0x1234567890123456789012345678901234567890",
  owners: [OWNER, OTHER_OWNER],
  threshold: 2,
  version: "1.4.1",
};

function pending(): PendingTx {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    id: "pending-1",
    treasuryId: "treasury-1",
    chain: "evm:11155111",
    state: "awaiting_signature",
    signingDigest: DIGEST,
    outputs: [{ to: OTHER_OWNER, amount: { asset: "ETH", value: "1", decimals: 18 } }],
    payloadJson: "{}",
    signatures: [],
    accounting: { payeeId: "vendor-1", fiat: { currency: "USD", minor: 2550n } },
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("pending transaction store", () => {
  it("deduplicates owners and advances only when the threshold is reached", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    const store = usePendingTransactionsStore.getState();
    store.addTransaction(pending());
    const first = { signerHash: OWNER, bytes: hexToBytes(await ownerAccount.sign({ hash: DIGEST })), signedAt: 1 };
    await expect(store.recordEvmSignature("pending-1", first, MULTISIG)).resolves.toBe(true);
    await expect(store.recordEvmSignature("pending-1", first, MULTISIG)).resolves.toBe(false);
    expect(usePendingTransactionsStore.getState().findById("pending-1")?.state).toBe("awaiting_signature");

    await store.recordEvmSignature(
      "pending-1",
      { signerHash: OTHER_OWNER, bytes: hexToBytes(await otherOwnerAccount.sign({ hash: DIGEST })), signedAt: 2 },
      MULTISIG,
    );
    expect(usePendingTransactionsStore.getState().findById("pending-1")?.state).toBe("ready_to_broadcast");
  });

  it("rejects non-owner and malformed signatures", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    const store = usePendingTransactionsStore.getState();
    store.addTransaction(pending());
    await expect(
      store.recordEvmSignature(
        "pending-1",
        { signerHash: "0x3333333333333333333333333333333333333333", bytes: new Uint8Array(65), signedAt: 1 },
        MULTISIG,
      ),
    ).rejects.toThrow("not an owner");
    await expect(
      store.recordEvmSignature(
        "pending-1",
        { signerHash: OWNER, bytes: new Uint8Array(64), signedAt: 1 },
        MULTISIG,
      ),
    ).rejects.toThrow("65 bytes");
    await expect(
      store.recordEvmSignature(
        "pending-1",
        {
          signerHash: OWNER,
          bytes: hexToBytes(await otherOwnerAccount.sign({ hash: DIGEST })),
          signedAt: 1,
        },
        MULTISIG,
      ),
    ).rejects.toThrow("does not recover");
  });

  it("restores exact signature bytes after store recreation", async () => {
    const first = await import("./pending-transactions");
    first.usePendingTransactionsStore.getState().addTransaction(pending());
    const bytes = hexToBytes(await ownerAccount.sign({ hash: DIGEST }));
    await first.usePendingTransactionsStore.getState().recordEvmSignature(
      "pending-1",
      { signerHash: OWNER, bytes, signedAt: 123 },
      MULTISIG,
    );

    vi.resetModules();
    const second = await import("./pending-transactions");
    await second.usePendingTransactionsStore.persist.rehydrate();
    const restored = second.usePendingTransactionsStore.getState().findById("pending-1")?.signatures[0];
    expect(restored?.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(restored?.signerHash).toBe(OWNER);
    expect(second.usePendingTransactionsStore.getState().findById("pending-1")?.accounting?.fiat.minor).toBe(2550n);
  });

  it("persists the broadcast-to-confirmed lifecycle", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    const store = usePendingTransactionsStore.getState();
    const ready = { ...pending(), state: "ready_to_broadcast" as const };
    store.addTransaction({ ...ready, state: "awaiting_signature" });
    usePendingTransactionsStore.setState({ transactions: [ready] });
    store.markBroadcasted("pending-1", `0x${"cd".repeat(32)}`);
    store.markConfirming("pending-1");
    store.markConfirmed("pending-1", {
      blockNumber: 7_123_456n,
      confirmedAt: "2026-08-01T01:02:03.000Z",
      executorAddress: "0x1111111111111111111111111111111111111111",
      gasUsed: 100_000n,
      effectiveGasPriceWei: 2_000_000_000n,
      gasFeeWei: 200_000_000_000_000n,
    });
    expect(usePendingTransactionsStore.getState().findById("pending-1")).toMatchObject({
      state: "confirmed",
      broadcastedHash: `0x${"cd".repeat(32)}`,
      confirmedBlockNumber: "7123456",
    });

    vi.resetModules();
    const restored = await import("./pending-transactions");
    await restored.usePendingTransactionsStore.persist.rehydrate();
    expect(restored.usePendingTransactionsStore.getState().findById("pending-1")).toMatchObject({
      state: "confirmed",
      broadcastedHash: `0x${"cd".repeat(32)}`,
      confirmedBlockNumber: "7123456",
    });
  });

  it("refuses invalid lifecycle jumps", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    usePendingTransactionsStore.getState().addTransaction(pending());
    expect(() => usePendingTransactionsStore.getState().markConfirming("pending-1")).toThrow(
      "awaiting_signature → confirming",
    );
  });

  it("recovers an interrupted accounting post as retry-safe post_failed", async () => {
    const first = await import("./pending-transactions");
    first.usePendingTransactionsStore.setState({
      transactions: [{ ...pending(), state: "confirmed" }],
    });
    first.usePendingTransactionsStore.getState().markPosting("pending-1");

    vi.resetModules();
    const second = await import("./pending-transactions");
    await second.usePendingTransactionsStore.persist.rehydrate();
    expect(second.usePendingTransactionsStore.getState().findById("pending-1")).toMatchObject({
      state: "post_failed",
      postError: expect.stringContaining("Retry is safe"),
    });
  });
});
