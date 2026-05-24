import { describe, it, expect, beforeEach } from "vitest";
import { useIncomingSigsStore, type IncomingSigEntry } from "./incoming-sigs";

const DIGEST_A = `0x${"a1".repeat(32)}`;
const DIGEST_B = `0x${"b2".repeat(32)}`;
const SIG_A = `0x${"01".repeat(65)}`;
const SIG_B = `0x${"02".repeat(65)}`;
const SENDER_A = `0x${"aa".repeat(20)}`;
const SENDER_B = `0x${"bb".repeat(20)}`;

function entry(overrides: Partial<IncomingSigEntry> = {}): IncomingSigEntry {
  return {
    sighashDigest: DIGEST_A,
    slotIndex: 0,
    signature: SIG_A,
    senderAddrHash: SENDER_A,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function reset(): void {
  useIncomingSigsStore.setState({ bySighash: {} });
  globalThis.localStorage?.removeItem("chain-pay:incoming-sigs");
}

describe("incoming-sigs store", () => {
  beforeEach(reset);

  it("starts with an empty bySighash map", () => {
    expect(useIncomingSigsStore.getState().bySighash).toEqual({});
  });

  it("enqueue adds an entry under its sighashDigest key", () => {
    const e = entry();
    useIncomingSigsStore.getState().enqueue(e);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toEqual([e]);
  });

  it("enqueue dedups by (sighashDigest, slotIndex, signature) triplet", () => {
    const e = entry();
    useIncomingSigsStore.getState().enqueue(e);
    useIncomingSigsStore.getState().enqueue({ ...e, receivedAt: e.receivedAt + 1000 });
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toHaveLength(1);
  });

  it("drain returns all entries for the key and clears the key", () => {
    const e1 = entry();
    const e2 = entry({ slotIndex: 1, signature: SIG_B, senderAddrHash: SENDER_B });
    useIncomingSigsStore.getState().enqueue(e1);
    useIncomingSigsStore.getState().enqueue(e2);
    const drained = useIncomingSigsStore.getState().drain(DIGEST_A);
    expect(drained).toEqual([e1, e2]);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
  });

  it("drain on a missing key returns an empty array", () => {
    expect(useIncomingSigsStore.getState().drain(DIGEST_B)).toEqual([]);
  });

  it("peek returns the same entries as drain would, without clearing", () => {
    const e = entry();
    useIncomingSigsStore.getState().enqueue(e);
    expect(useIncomingSigsStore.getState().peek(DIGEST_A)).toEqual([e]);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toEqual([e]);
  });

  it("prune drops entries older than maxAgeMs, keeps the rest", () => {
    const now = 1_700_000_000_000;
    const old = entry({ receivedAt: now - 10_000 });
    const fresh = entry({ slotIndex: 1, signature: SIG_B, receivedAt: now - 100 });
    useIncomingSigsStore.getState().enqueue(old);
    useIncomingSigsStore.getState().enqueue(fresh);
    useIncomingSigsStore.getState().prune(1_000, now);
    const remaining = useIncomingSigsStore.getState().bySighash[DIGEST_A] ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.slotIndex).toBe(1);
  });

  it("prune removes the key entirely when all its entries expire", () => {
    const now = 1_700_000_000_000;
    useIncomingSigsStore.getState().enqueue(entry({ receivedAt: now - 10_000 }));
    useIncomingSigsStore.getState().prune(1_000, now);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
  });

  it("enqueues from different senders for the same digest append separately", () => {
    const fromA = entry();
    const fromB = entry({ slotIndex: 1, signature: SIG_B, senderAddrHash: SENDER_B });
    useIncomingSigsStore.getState().enqueue(fromA);
    useIncomingSigsStore.getState().enqueue(fromB);
    expect(useIncomingSigsStore.getState().bySighash[DIGEST_A]).toHaveLength(2);
  });
});
