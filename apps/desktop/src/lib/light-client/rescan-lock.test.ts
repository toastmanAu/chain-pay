import { describe, it, expect, vi } from "vitest";
import { LightClientSetScriptsCommand } from "@nervosnetwork/ckb-light-client-js";
import { rescanLock, rescanScriptStatuses } from "./rescan-lock";

const script = { codeHash: ("0x" + "11".repeat(32)) as `0x${string}`, hashType: "type" as const, args: ("0x" + "22".repeat(20)) as `0x${string}` };
const otherScript = { codeHash: ("0x" + "33".repeat(32)) as `0x${string}`, hashType: "type" as const, args: ("0x" + "44".repeat(20)) as `0x${string}` };

describe("rescanLock", () => {
  it("rebuilds the chain index before restoring the target watch", async () => {
    const events: string[] = [];
    const deps = {
      getScripts: vi.fn(async () => [
        { script, scriptType: "lock" as const, blockNumber: 99_999n },
      ]),
      stop: vi.fn(async () => { events.push("stop"); }),
      deleteChainIndex: vi.fn(async () => { events.push("delete"); }),
      start: vi.fn(async () => { events.push("start"); }),
      setScripts: vi.fn(async (_scripts, _command) => { events.push("setScripts"); }),
    };

    await rescanLock(deps, script, 12_345n);

    expect(events).toEqual(["stop", "delete", "start", "setScripts"]);
    expect(deps.setScripts).toHaveBeenCalledWith(
      [{ script: expect.objectContaining(script), scriptType: "lock", blockNumber: 12_345n }],
      LightClientSetScriptsCommand.All,
    );
  });

  it("rewinds every watch to the requested global start instead of reusing progress cursors", () => {
    const statuses = rescanScriptStatuses(
      [
        { script, scriptType: "lock", blockNumber: 50_000n },
        { script: otherScript, scriptType: "lock", blockNumber: 60_000n },
      ],
      script,
      12_345n,
    );

    expect(statuses).toEqual([
      { script: otherScript, scriptType: "lock", blockNumber: 12_345n },
      { script: expect.objectContaining(script), scriptType: "lock", blockNumber: 12_345n },
    ]);
  });

  it("removes stale cells because the recoverable index is deleted before replay", async () => {
    const localCells = new Set(["stale-spent", "live"]);
    const authoritativeCells = new Set(["live"]);
    const deps = {
      getScripts: vi.fn(async () => []),
      stop: vi.fn(async () => {}),
      deleteChainIndex: vi.fn(async () => { localCells.clear(); }),
      start: vi.fn(async () => {}),
      setScripts: vi.fn(async () => {
        for (const cell of authoritativeCells) localCells.add(cell);
      }),
    };

    await rescanLock(deps, script, 0n);

    expect([...localCells]).toEqual(["live"]);
  });

  it("restarts the prior index if deletion fails", async () => {
    const deps = {
      getScripts: vi.fn(async () => []),
      stop: vi.fn(async () => {}),
      deleteChainIndex: vi.fn(async () => { throw new Error("delete boom"); }),
      start: vi.fn(async () => {}),
      setScripts: vi.fn(async () => {}),
    };

    await expect(rescanLock(deps, script, 5n)).rejects.toThrow("delete boom");
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.setScripts).not.toHaveBeenCalled();
  });
});
