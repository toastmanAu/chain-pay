import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollBatch, PayrollBatchLine } from "@chain-pay/shared";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const sampleLine: PayrollBatchLine = {
  payeeId: "p1",
  fiat: { currency: "USD", minor: 500000n },
  crypto: { asset: "CKB", value: 119047619047619n, decimals: 8 },
  fxRate: "0.0042",
  feeAllocated: { asset: "CKB", value: 100_000n, decimals: 8 },
};

const sampleBatch: PayrollBatch = {
  id: "b1",
  label: "May 2026 payroll",
  treasuryId: "t-testnet",
  cycleStart: "2026-05-01",
  cycleEnd: "2026-05-31",
  fxSnapshot: [
    {
      base: "CKB",
      quote: "USD",
      rate: "0.0042",
      source: "coingecko",
      takenAt: 1747900000000,
    },
  ],
  lines: [sampleLine],
  state: "draft",
  createdAt: "2026-05-22T00:00:00Z",
  updatedAt: "2026-05-22T00:00:00Z",
};

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("payroll-batches store", () => {
  it("starts with an empty batch list", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    expect(usePayrollBatchesStore.getState().batches).toEqual([]);
  });

  it("persists added batches across re-imports", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(sampleBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];
    expect(got?.id).toBe("b1");
    expect(got?.label).toBe("May 2026 payroll");
    expect(got?.state).toBe("draft");
  });

  it("round-trips bigint values through localStorage (fiat.minor and crypto.value)", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(sampleBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];
    expect(got?.lines[0]?.fiat.minor).toBe(500000n);
    expect(got?.lines[0]?.crypto.value).toBe(119047619047619n);
  });

  it("transition() advances state on valid transitions and bumps updatedAt", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    const originalUpdatedAt = usePayrollBatchesStore.getState().batches[0]?.updatedAt;

    // Microsleep so updatedAt actually differs
    await new Promise((r) => setTimeout(r, 5));

    usePayrollBatchesStore.getState().transition("b1", "calculated");
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.state).toBe("calculated");
    expect(b?.updatedAt).not.toBe(originalUpdatedAt);
    expect(b?.createdAt).toBe(sampleBatch.createdAt); // preserved
  });

  it("transition() throws on invalid transition without mutating the batch", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    expect(() => usePayrollBatchesStore.getState().transition("b1", "broadcasted")).toThrow(
      /draft.*broadcasted/,
    );
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.state).toBe("draft"); // unchanged
  });

  it("transition() is a no-op (throws) for unknown batch id", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    expect(() => usePayrollBatchesStore.getState().transition("nope", "calculated")).toThrow(
      /batch.*nope/i,
    );
  });

  it("updateBatch preserves id and createdAt, replaces other fields", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().updateBatch("b1", { label: "May payroll v2" });
    const b = usePayrollBatchesStore.getState().batches[0];
    expect(b?.id).toBe("b1");
    expect(b?.createdAt).toBe(sampleBatch.createdAt);
    expect(b?.label).toBe("May payroll v2");
  });

  it("removeBatch deletes by id", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().addBatch({ ...sampleBatch, id: "b2", label: "June" });
    usePayrollBatchesStore.getState().removeBatch("b1");
    const batches = usePayrollBatchesStore.getState().batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]?.id).toBe("b2");
  });

  it("findById returns the matching batch or undefined", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    expect(usePayrollBatchesStore.getState().findById("b1")?.label).toBe("May 2026 payroll");
    expect(usePayrollBatchesStore.getState().findById("nope")).toBeUndefined();
  });

  it("multiple batches at different states stay independent under transition()", async () => {
    const { usePayrollBatchesStore } = await import("./payroll-batches");
    usePayrollBatchesStore.getState().addBatch(sampleBatch);
    usePayrollBatchesStore.getState().addBatch({ ...sampleBatch, id: "b2", label: "June" });

    usePayrollBatchesStore.getState().transition("b1", "calculated");

    const all = usePayrollBatchesStore.getState().batches;
    expect(all.find((b) => b.id === "b1")?.state).toBe("calculated");
    expect(all.find((b) => b.id === "b2")?.state).toBe("draft");
  });

  it("draft persistence: txBytes + sighashDigest + totals + partialSigs round-trip lossless", async () => {
    const draftBatch: PayrollBatch = {
      ...sampleBatch,
      id: "draft-1",
      state: "calculated",
      txBytes:
        "0x00000000010000000000000000000000000000000000000000000000000000000000000000000000",
      sighashDigest:
        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      totals: {
        totalIn: 50_000_000_000n,
        totalOut: 49_500_000_000n,
        fee: 500_000n,
        change: 0n,
      },
      partialSigs: [
        { slotIndex: 0, signature: "0x" + "11".repeat(65) },
        { slotIndex: 1, signature: "0x" + "22".repeat(65) },
      ],
    };

    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().addBatch(draftBatch);

    vi.resetModules();
    const second = await import("./payroll-batches");
    const got = second.usePayrollBatchesStore.getState().batches[0];

    expect(got?.txBytes).toBe(draftBatch.txBytes);
    expect(got?.sighashDigest).toBe(draftBatch.sighashDigest);
    expect(got?.totals?.totalIn).toBe(50_000_000_000n);
    expect(got?.totals?.totalOut).toBe(49_500_000_000n);
    expect(got?.totals?.fee).toBe(500_000n);
    expect(got?.totals?.change).toBe(0n);
    expect(got?.partialSigs).toHaveLength(2);
    expect(got?.partialSigs?.[0]?.signature).toBe("0x" + "11".repeat(65));
    expect(got?.partialSigs?.[1]?.slotIndex).toBe(1);
  });

  it("selectDraft sets and clears selectedDraftId without persisting it", async () => {
    const first = await import("./payroll-batches");
    first.usePayrollBatchesStore.getState().selectDraft("draft-1");
    expect(first.usePayrollBatchesStore.getState().selectedDraftId).toBe("draft-1");

    // selectedDraftId is intentionally ephemeral — the partialize config keeps
    // it out of localStorage so a fresh window doesn't auto-resume a draft.
    vi.resetModules();
    const second = await import("./payroll-batches");
    expect(second.usePayrollBatchesStore.getState().selectedDraftId).toBeNull();
  });
});

// ── 2.7b-2: drainIncomingSigsInto + recordCommSendStatus + auto-transition ───

describe("payroll-batches store — comm-channel auto-match", () => {
  const DIGEST = "0x" + "ab".repeat(32);
  // Two real secp keys so we can produce recoverable sigs.
  const KEY_A = "0x" + "11".repeat(32);
  const KEY_B = "0x" + "22".repeat(32);
  const KEY_C = "0x" + "33".repeat(32);

  async function setup() {
    const batches = await import("./payroll-batches");
    const incoming = await import("./incoming-sigs");
    const signer = await import("@/lib/signers/ckb-secp256k1");
    return { batches, incoming, signer };
  }

  function calculatedBatch(): PayrollBatch {
    return {
      ...sampleBatch,
      id: "comm-1",
      state: "calculated",
      sighashDigest: DIGEST,
      partialSigs: [],
    };
  }

  it("drainIncomingSigsInto pulls a valid buffered sig and stamps signerPubkeyHash + sourceCommTx", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const sigA = signer.signDigest(DIGEST, KEY_A);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigA,
      senderAddrHash: "0x" + "aa".repeat(20),
      receivedAt: 1700000000000,
      sourceCommTx: "0xc0c0",
    });

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, signer.pubkeyHashFromPrivateKey(KEY_B)] },
    );

    expect(result).toEqual({ merged: 1, rejected: 0 });
    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.partialSigs).toHaveLength(1);
    expect(got?.partialSigs?.[0]?.slotIndex).toBe(0);
    expect(got?.partialSigs?.[0]?.signerPubkeyHash).toBe(hashA);
    expect(got?.partialSigs?.[0]?.sourceCommTx).toBe("0xc0c0");
    expect(incoming.useIncomingSigsStore.getState().bySighash[DIGEST]).toBeUndefined();
  });

  it("drainIncomingSigsInto dedups by slotIndex — first valid wins", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const sigA = signer.signDigest(DIGEST, KEY_A);
    const sigB = signer.signDigest(DIGEST, KEY_B);

    batches.usePayrollBatchesStore.getState().addBatch({
      ...calculatedBatch(),
      partialSigs: [
        {
          slotIndex: 0,
          signature: sigA,
          signerPubkeyHash: hashA,
        },
      ],
    });
    // Second sig for slot 0 (from a different signer) — should be rejected as dup.
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigB,
      senderAddrHash: "0x" + "bb".repeat(20),
      receivedAt: 1700000000000,
    });

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, hashB] },
    );
    expect(result.rejected).toBe(1);
    expect(batches.usePayrollBatchesStore.getState().findById("comm-1")?.partialSigs).toHaveLength(
      1,
    );
  });

  it("drainIncomingSigsInto rejects a sig that recovers to the wrong slot hash", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const hashC = signer.pubkeyHashFromPrivateKey(KEY_C);
    const sigC = signer.signDigest(DIGEST, KEY_C);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    // KEY_C signed, but pubkeyHashes only knows A and B — recovered hash won't match either.
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigC,
      senderAddrHash: "0x" + "cc".repeat(20),
      receivedAt: 1700000000000,
    });
    void hashC;

    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "comm-1",
      { m: 2, pubkeyHashes: [hashA, hashB] },
    );
    expect(result).toEqual({ merged: 0, rejected: 1 });
    expect(batches.usePayrollBatchesStore.getState().findById("comm-1")?.partialSigs).toEqual([]);
  });

  it("drainIncomingSigsInto on a missing batch returns zero merges and zero rejects", async () => {
    const { batches } = await setup();
    const result = batches.usePayrollBatchesStore.getState().drainIncomingSigsInto(
      "does-not-exist",
      { m: 2, pubkeyHashes: [`0x${"00".repeat(20)}`] },
    );
    expect(result).toEqual({ merged: 0, rejected: 0 });
  });

  it("drainIncomingSigsInto auto-transitions calculated → approved when M sigs collected", async () => {
    const { batches, incoming, signer } = await setup();
    const hashA = signer.pubkeyHashFromPrivateKey(KEY_A);
    const hashB = signer.pubkeyHashFromPrivateKey(KEY_B);
    const sigA = signer.signDigest(DIGEST, KEY_A);
    const sigB = signer.signDigest(DIGEST, KEY_B);

    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 0,
      signature: sigA,
      senderAddrHash: "0x" + "aa".repeat(20),
      receivedAt: 1700000000000,
    });
    incoming.useIncomingSigsStore.getState().enqueue({
      sighashDigest: DIGEST,
      slotIndex: 1,
      signature: sigB,
      senderAddrHash: "0x" + "bb".repeat(20),
      receivedAt: 1700000000000,
    });

    batches.usePayrollBatchesStore.getState().drainIncomingSigsInto("comm-1", {
      m: 2,
      pubkeyHashes: [hashA, hashB],
    });

    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.partialSigs).toHaveLength(2);
    expect(got?.state).toBe("approved");
  });

  it("recordCommSendStatus writes a per-slot entry under commSendStatus", async () => {
    const { batches } = await setup();
    batches.usePayrollBatchesStore.getState().addBatch(calculatedBatch());
    batches.usePayrollBatchesStore
      .getState()
      .recordCommSendStatus("comm-1", 0, "sent", { txHash: "0xdeadbeef" });
    const got = batches.usePayrollBatchesStore.getState().findById("comm-1");
    expect(got?.commSendStatus?.[0]?.status).toBe("sent");
    expect(got?.commSendStatus?.[0]?.txHash).toBe("0xdeadbeef");
    expect(typeof got?.commSendStatus?.[0]?.updatedAt).toBe("number");
  });
});
