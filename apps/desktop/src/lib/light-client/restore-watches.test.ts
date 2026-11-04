import { describe, expect, it, vi } from "vitest";
import { Address, Script } from "@ckb-ccc/core";
import type { Source, Treasury } from "@chain-pay/shared";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import { restorePersistedWatches } from "./restore-watches";

const sourceScript = Script.from({ codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: `0x${"22".repeat(20)}` });
const source: Source = {
  id: "source", label: "Public test", chain: "ckb:testnet",
  address: Address.from({ script: sourceScript, prefix: "ckt" }).toString(),
  joyidLockArgs: `0x${"22".repeat(20)}`,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const treasuryHashes = [`0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`] as const;
const treasury: Treasury = {
  id: "treasury", label: "Public test treasury",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  multisig: {
    chain: "ckb:testnet", s: 0, r: 1, m: 2, n: 2,
    pubkeyHashes: [...treasuryHashes], address: "ckt1public-test",
  },
};

function deps(watched: Script[] = []) {
  const scripts = [...watched];
  const watchLockScript = vi.fn(async (script: Script, _fromBlock: bigint) => { scripts.push(script); });
  return {
    getWatchedScripts: vi.fn(async () => scripts.map(script => ({ script, scriptType: "lock" as const, blockNumber: 0n }))),
    watchLockScript,
  };
}

describe("restorePersistedWatches", () => {
  it("restores missing persisted source and treasury locks from genesis", async () => {
    const host = deps();
    await restorePersistedWatches(host, "testnet", [source], [treasury]);
    expect(host.watchLockScript).toHaveBeenCalledTimes(2);
    expect(host.watchLockScript.mock.calls.every((call) => call[1] === 0n)).toBe(true);
    const expectedTreasury = Script.from(treasuryLockScript({ s: 0, r: 1, m: 2, n: 2, pubkeyHashes: [...treasuryHashes] }));
    expect(host.watchLockScript.mock.calls.some((call) => call[0].eq(expectedTreasury))).toBe(true);
  });

  it("preserves existing watches and does not re-register them", async () => {
    const host = deps([sourceScript]);
    await restorePersistedWatches(host, "testnet", [source], []);
    expect(host.watchLockScript).not.toHaveBeenCalled();
  });

  it("restores valid watches even when one persisted source address is invalid", async () => {
    const host = deps();
    const malformed = { ...source, id: "malformed", address: "invalid" };
    await expect(restorePersistedWatches(host, "testnet", [malformed, source], [treasury]))
      .rejects.toThrow(/malformed/);
    expect(host.watchLockScript).toHaveBeenCalledTimes(2);
  });

  it("skips records from a different CKB network", async () => {
    const host = deps();
    await restorePersistedWatches(host, "mainnet", [source], [treasury]);
    expect(host.watchLockScript).not.toHaveBeenCalled();
  });
});
