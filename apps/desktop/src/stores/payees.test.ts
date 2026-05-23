import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayeeProfile } from "@chain-pay/shared";

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

const samplePayee: PayeeProfile = {
  id: "p1",
  displayName: "Alice Operator",
  createdAt: "2026-05-21T00:00:00Z",
  updatedAt: "2026-05-21T00:00:00Z",
  salaryFiat: { currency: "USD", minor: 500000n },
  preferredChain: "ckb:testnet",
  preferredAsset: "CKB",
  walletAddress:
    "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2yl2dtdldv6jp87hkpd8p3a8n77346jzq2wz6r9",
  active: true,
};

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("payees store", () => {
  it("starts with an empty payee list", async () => {
    const { usePayeesStore } = await import("./payees");
    expect(usePayeesStore.getState().payees).toEqual([]);
  });

  it("persists added payees across re-imports", async () => {
    const first = await import("./payees");
    first.usePayeesStore.getState().addPayee(samplePayee);
    expect(first.usePayeesStore.getState().payees).toHaveLength(1);

    vi.resetModules();
    const second = await import("./payees");
    const got = second.usePayeesStore.getState().payees[0];
    expect(got?.id).toBe("p1");
    expect(got?.displayName).toBe("Alice Operator");
    expect(got?.walletAddress).toBe(samplePayee.walletAddress);
  });

  it("round-trips the bigint `salaryFiat.minor` field through localStorage", async () => {
    const first = await import("./payees");
    first.usePayeesStore.getState().addPayee(samplePayee);

    vi.resetModules();
    const second = await import("./payees");
    const got = second.usePayeesStore.getState().payees[0];
    expect(got?.salaryFiat.currency).toBe("USD");
    expect(got?.salaryFiat.minor).toBe(500000n);
  });

  it("updatePayee replaces fields and bumps updatedAt without changing id/createdAt", async () => {
    const { usePayeesStore } = await import("./payees");
    usePayeesStore.getState().addPayee(samplePayee);
    usePayeesStore.getState().updatePayee("p1", {
      displayName: "Alice Renamed",
      active: false,
    });
    const got = usePayeesStore.getState().payees[0];
    expect(got?.id).toBe("p1");
    expect(got?.displayName).toBe("Alice Renamed");
    expect(got?.active).toBe(false);
    expect(got?.createdAt).toBe("2026-05-21T00:00:00Z");
    expect(got?.updatedAt).not.toBe("2026-05-21T00:00:00Z");
  });

  it("removePayee deletes by id without touching others", async () => {
    const { usePayeesStore } = await import("./payees");
    usePayeesStore.getState().addPayee(samplePayee);
    usePayeesStore.getState().addPayee({ ...samplePayee, id: "p2", displayName: "Bob" });
    usePayeesStore.getState().removePayee("p1");
    expect(usePayeesStore.getState().payees).toHaveLength(1);
    expect(usePayeesStore.getState().payees[0]?.id).toBe("p2");
  });

  it("findById returns the matching payee or undefined", async () => {
    const { usePayeesStore } = await import("./payees");
    usePayeesStore.getState().addPayee(samplePayee);
    expect(usePayeesStore.getState().findById("p1")?.displayName).toBe("Alice Operator");
    expect(usePayeesStore.getState().findById("nonexistent")).toBeUndefined();
  });
});
