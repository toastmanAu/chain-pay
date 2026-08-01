import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER_OWNER = "0x2222222222222222222222222222222222222222";
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
    signingDigest: `0x${"ab".repeat(32)}`,
    outputs: [{ to: OTHER_OWNER, amount: { asset: "ETH", value: "1", decimals: 18 } }],
    payloadJson: "{}",
    signatures: [],
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
    const first = { signerHash: OWNER, bytes: new Uint8Array(65).fill(1), signedAt: 1 };
    expect(store.recordEvmSignature("pending-1", first, MULTISIG)).toBe(true);
    expect(store.recordEvmSignature("pending-1", first, MULTISIG)).toBe(false);
    expect(usePendingTransactionsStore.getState().findById("pending-1")?.state).toBe("awaiting_signature");

    store.recordEvmSignature(
      "pending-1",
      { signerHash: OTHER_OWNER, bytes: new Uint8Array(65).fill(2), signedAt: 2 },
      MULTISIG,
    );
    expect(usePendingTransactionsStore.getState().findById("pending-1")?.state).toBe("ready_to_broadcast");
  });

  it("rejects non-owner and malformed signatures", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    const store = usePendingTransactionsStore.getState();
    store.addTransaction(pending());
    expect(() =>
      store.recordEvmSignature(
        "pending-1",
        { signerHash: "0x3333333333333333333333333333333333333333", bytes: new Uint8Array(65), signedAt: 1 },
        MULTISIG,
      ),
    ).toThrow("not an owner");
    expect(() =>
      store.recordEvmSignature(
        "pending-1",
        { signerHash: OWNER, bytes: new Uint8Array(64), signedAt: 1 },
        MULTISIG,
      ),
    ).toThrow("65 bytes");
  });

  it("restores exact signature bytes after store recreation", async () => {
    const first = await import("./pending-transactions");
    first.usePendingTransactionsStore.getState().addTransaction(pending());
    const bytes = Uint8Array.from({ length: 65 }, (_, index) => index);
    first.usePendingTransactionsStore.getState().recordEvmSignature(
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
  });

  it("persists the broadcast-to-confirmed lifecycle", async () => {
    const { usePendingTransactionsStore } = await import("./pending-transactions");
    const store = usePendingTransactionsStore.getState();
    const ready = { ...pending(), state: "ready_to_broadcast" as const };
    store.addTransaction({ ...ready, state: "awaiting_signature" });
    usePendingTransactionsStore.setState({ transactions: [ready] });
    store.markBroadcasted("pending-1", `0x${"cd".repeat(32)}`);
    store.markConfirming("pending-1");
    store.markConfirmed("pending-1", 7_123_456n);
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
});
