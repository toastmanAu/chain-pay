import { describe, it, expect, vi } from "vitest";
import { LightClientSetScriptsCommand } from "@nervosnetwork/ckb-light-client-js";
import { rescanLock } from "./rescan-lock";

const script = { codeHash: ("0x" + "11".repeat(32)) as `0x${string}`, hashType: "type" as const, args: ("0x" + "22".repeat(20)) as `0x${string}` };

describe("rescanLock", () => {
  it("deletes the stale cursor then re-adds the lock at fromBlock", async () => {
    const calls: Array<{ scripts: unknown; command: LightClientSetScriptsCommand }> = [];
    const client = {
      setScripts: vi.fn(async (scripts, command) => { calls.push({ scripts, command }); }),
    };

    await rescanLock(client, script, 12_345n);

    expect(client.setScripts).toHaveBeenCalledTimes(2);
    // First call: Delete
    expect(calls[0]?.command).toBe(LightClientSetScriptsCommand.Delete);
    expect(calls[0]?.scripts).toEqual([{ script, scriptType: "lock", blockNumber: 0n }]);
    // Second call: Partial re-add at fromBlock
    expect(calls[1]?.command).toBe(LightClientSetScriptsCommand.Partial);
    expect(calls[1]?.scripts).toEqual([{ script, scriptType: "lock", blockNumber: 12_345n }]);
  });

  it("re-adds at genesis (0n) for a from-genesis rescan", async () => {
    const client = { setScripts: vi.fn(async () => {}) };
    await rescanLock(client, script, 0n);
    expect(client.setScripts).toHaveBeenLastCalledWith(
      [{ script, scriptType: "lock", blockNumber: 0n }],
      LightClientSetScriptsCommand.Partial,
    );
  });

  it("does not re-add if the delete fails (no orphaned watch)", async () => {
    const client = { setScripts: vi.fn(async () => { throw new Error("delete boom"); }) };
    await expect(rescanLock(client, script, 5n)).rejects.toThrow("delete boom");
    expect(client.setScripts).toHaveBeenCalledTimes(1);
  });
});
