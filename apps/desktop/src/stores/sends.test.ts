import { describe, it, expect, beforeEach } from "vitest";
import type { SendRecord } from "@chain-pay/shared";

function makeSend(id: string): SendRecord {
  return {
    id,
    sourceId: "src1",
    chain: "ckb:testnet",
    outputs: [
      {
        payeeId: "p1",
        payeeAddress: "ckt1qpayee",
        amount: { asset: "CKB", value: 7_000_000_000n, decimals: 8 },
        fiat: { currency: "AUD", minor: 10000n },
      },
    ],
    feeShannons: 0n,
    state: "draft",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("useSendsStore", () => {
  it("drives a send through the happy path", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("x"));
    st.markBuilt("x", 1200n);
    st.markSigning("x");
    st.markBroadcasted("x", "0xabc");
    st.markConfirmed("x");
    st.markPosting("x");
    st.markPosted("x", "ACC-JV-0001");
    const s = useSendsStore.getState().sends.find((r) => r.id === "x")!;
    expect(s.state).toBe("posted");
    expect(s.feeShannons).toBe(1200n);
    expect(s.txHash).toBe("0xabc");
    expect(s.journalEntryName).toBe("ACC-JV-0001");
  });

  it("rejects an illegal transition", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    useSendsStore.getState().addSend(makeSend("y"));
    expect(() => useSendsStore.getState().markConfirmed("y")).toThrow(/invalid send transition/);
  });

  it("records a post failure and allows retry back to posting", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("z"));
    st.markBuilt("z", 1200n);
    st.markSigning("z");
    st.markBroadcasted("z", "0xdef");
    st.markConfirmed("z");
    st.markPosting("z");
    st.markPostFailed("z", "backend down");
    const s = useSendsStore.getState().sends.find((r) => r.id === "z")!;
    expect(s.state).toBe("post_failed");
    expect(s.postError).toBe("backend down");
    useSendsStore.getState().markPosting("z");
    expect(useSendsStore.getState().sends.find((r) => r.id === "z")!.state).toBe("posting");
  });

  it("exercises markBackToBuilt from signing state", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("w"));
    st.markBuilt("w", 1200n);
    st.markSigning("w");
    st.markBackToBuilt("w");
    expect(useSendsStore.getState().sends.find((r) => r.id === "w")!.state).toBe("built");
  });

  it("throws when markBackToBuilt is called from illegal starting state", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("v"));
    st.markBuilt("v", 1200n);
    // broadcasted state cannot go back to built
    st.markSigning("v");
    st.markBroadcasted("v", "0xabc");
    expect(() => st.markBackToBuilt("v")).toThrow(/invalid send transition/);
  });

  it("throws when transitioning with unknown send id", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("known"));
    expect(() => st.markBuilt("unknown", 1200n)).toThrow(/send not found: unknown/);
  });
});
