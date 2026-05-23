import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Treasury } from "@chain-pay/shared";

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

const sample: Treasury = {
  id: "t1",
  label: "ops-testnet",
  createdAt: "2026-05-21T00:00:00Z",
  updatedAt: "2026-05-21T00:00:00Z",
  multisig: {
    chain: "ckb:testnet",
    s: 0,
    r: 0,
    m: 2,
    n: 3,
    pubkeyHashes: [
      "0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908",
      "0x0463eacbe31265f36f1ac23d26b28755ed34a767",
      "0xe4d15db3846f6ecd38b760298419450b21391e73",
    ],
    address:
      "ckt1qpw9q60tppt7l3j7r09qcp7lxnp3vcanvgha8pmvsa3jplykxn32sqw4amy0qryz7umdxvh0mpvugn3xyaqv75q7vlphx",
  },
};

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("treasury store persistence", () => {
  it("re-hydrates treasuries from localStorage on store re-creation", async () => {
    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(sample);
    expect(first.useTreasuryStore.getState().treasuries).toHaveLength(1);

    vi.resetModules();
    const second = await import("./treasury");
    expect(second.useTreasuryStore.getState().treasuries).toHaveLength(1);
    expect(second.useTreasuryStore.getState().treasuries[0]?.id).toBe("t1");
    expect(second.useTreasuryStore.getState().treasuries[0]?.multisig.address).toBe(
      sample.multisig.address,
    );
  });

  it("removes treasuries from persisted state on removeTreasury", async () => {
    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(sample);
    first.useTreasuryStore.getState().removeTreasury("t1");

    vi.resetModules();
    const second = await import("./treasury");
    expect(second.useTreasuryStore.getState().treasuries).toHaveLength(0);
  });

  it("round-trips bigint `since` values without precision loss", async () => {
    if (sample.multisig.chain !== "ckb:testnet") throw new Error("sample must be CKB");
    const withSince: Treasury = {
      ...sample,
      id: "t2",
      multisig: { ...sample.multisig, since: 0x4000000000000064n },
    };

    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(withSince);

    vi.resetModules();
    const second = await import("./treasury");
    const revived = second.useTreasuryStore.getState().treasuries[0];
    expect(revived?.multisig).toMatchObject({ chain: "ckb:testnet" });
    if (revived?.multisig.chain === "ckb:testnet") {
      expect(revived.multisig.since).toBe(0x4000000000000064n);
    }
  });
});
