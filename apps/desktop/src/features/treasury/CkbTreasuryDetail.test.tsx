// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Script } from "@ckb-ccc/core";
import type { MultisigTreasury } from "@chain-pay/shared";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import { CkbTreasuryDetail } from "./CkbTreasuryDetail";

const watchLockScript = vi.fn(async () => undefined);
vi.mock("@/lib/light-client/client", () => ({
  lightClient: () => ({ watchLockScript, getLockBalance: async () => 0n }),
}));
vi.mock("@/stores/sync", () => ({
  useSyncStore: (selector: (state: unknown) => unknown) => selector({
    ckb: { started: true, tipBlockNumber: 1_000n, peers: 2 },
  }),
}));

const pubkeyHashes = [`0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`] as const;
const treasury: MultisigTreasury = {
  id: "treasury", label: "Required signer test",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  multisig: {
    chain: "ckb:testnet", s: 0, r: 1, m: 2, n: 2,
    pubkeyHashes: [...pubkeyHashes], address: "ckt1public-test",
  },
};

describe("CkbTreasuryDetail", () => {
  it("watches the stored multisig lock when a required signer is configured", async () => {
    watchLockScript.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><CkbTreasuryDetail treasury={treasury} /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(watchLockScript).toHaveBeenCalled());
    const [watched, fromBlock] = watchLockScript.mock.calls[0] as unknown as [unknown, bigint];
    const expected = treasuryLockScript({
      s: 0, r: 1, m: 2, n: 2, pubkeyHashes: [...pubkeyHashes],
    });
    expect(Script.from(watched as Parameters<typeof Script.from>[0]).eq(Script.from(expected))).toBe(true);
    expect(fromBlock).toBe(800n);
  });
});
