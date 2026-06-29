// apps/desktop/src/lib/send/build-and-send.test.ts
import { describe, it, expect, vi } from "vitest";
import { Cell, Script, ScriptInfo, hexFrom } from "@ckb-ccc/core";
import type { SendRecord, Source, Hex20 } from "@chain-pay/shared";
import type { CkbTxSigner } from "@/lib/signers/ckb-tx-signer";
import { MockCkbTxSigner } from "@/lib/signers/mock-ckb-tx-signer";
import { buildAndSend, type SendDeps } from "./build-and-send";

const JOYID = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

function joyidScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: JOYID, hashType: "type",
    cellDeps: [{ cellDep: { outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 }, depType: "depGroup" } }],
  });
}
function secp256k1ScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: SECP, hashType: "type",
    cellDeps: [{ cellDep: { outPoint: { txHash: "0x" + "ef".repeat(32), index: 0 }, depType: "depGroup" } }],
  });
}
function source(): Source {
  return {
    id: "src1", label: "Ops", chain: "ckb:testnet",
    address: "ckt1qsource", joyidLockArgs: ("0x" + "11".repeat(20)) as Hex20,
    createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
  };
}
function send(): SendRecord {
  return {
    id: "snd1", sourceId: "src1", chain: "ckb:testnet",
    outputs: [{ payeeId: "p1", payeeAddress: "ckt1qpayee", amount: { asset: "CKB", value: 100n * 100_000_000n, decimals: 8 }, fiat: { currency: "AUD", minor: 10000n } }],
    feeShannons: 0n, state: "built",
    createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
  };
}
function cell(): Cell {
  return Cell.from({
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
    cellOutput: { capacity: 200n * 100_000_000n, lock: Script.from({ codeHash: JOYID, hashType: "type", args: "0x" + "11".repeat(20) }) },
    outputData: hexFrom("0x"),
  });
}

function deps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    listCellsForLock: vi.fn(async () => [cell()]),
    broadcast: vi.fn(async () => "0xbroadcasthash"),
    resolveRecipientLock: vi.fn(async () => Script.from({ codeHash: SECP, hashType: "type", args: "0x" + "22".repeat(20) })),
    scriptInfo: joyidScriptInfo(),
    markSigning: vi.fn(),
    markBroadcasted: vi.fn(),
    markBackToBuilt: vi.fn(),
    ...over,
  };
}

describe("buildAndSend", () => {
  it("builds, signs, broadcasts and records the tx hash", async () => {
    const d = deps();
    const res = await buildAndSend(send(), source(), new MockCkbTxSigner(), 1200n, d);
    expect(res.txHash).toBe("0xbroadcasthash");
    expect(d.markSigning).toHaveBeenCalledWith("snd1");
    expect(d.markBroadcasted).toHaveBeenCalledWith("snd1", "0xbroadcasthash");
  });

  it("returns the send to built and rethrows on broadcast failure", async () => {
    const d = deps({ broadcast: vi.fn(async () => { throw new Error("pool rejected"); }) });
    await expect(buildAndSend(send(), source(), new MockCkbTxSigner(), 1200n, d)).rejects.toThrow(/pool rejected/);
    expect(d.markBackToBuilt).toHaveBeenCalledWith("snd1");
    expect(d.markBroadcasted).not.toHaveBeenCalled();
  });

  it("returns the send to built and rethrows when signing fails", async () => {
    const d = deps();
    const failingSigner: CkbTxSigner = {
      kind: "joyid" as const,
      connect: async () => ({ address: "ckt1qmocksource", lockArgs: "0x" + "11".repeat(20) }),
      signTransaction: async () => { throw new Error("user rejected in JoyID"); },
    };
    await expect(buildAndSend(send(), source(), failingSigner, 1200n, d)).rejects.toThrow(/user rejected/);
    expect(d.markBackToBuilt).toHaveBeenCalledWith("snd1");
    expect(d.markBroadcasted).not.toHaveBeenCalled();
  });
});

describe("buildAndSend — source lock kind branching", () => {
  it("uses the JoyID lock when lockKind is absent (default/back-compat)", async () => {
    const capturedLocks: Script[] = [];
    const d = deps({
      listCellsForLock: vi.fn(async (lock: Script) => { capturedLocks.push(lock); return [cell()]; }),
    });
    await buildAndSend(send(), source(), new MockCkbTxSigner(), 1200n, d);
    expect(capturedLocks[0]?.codeHash).toBe(JOYID);
  });

  it("uses the secp256k1 lock when source.lockKind is 'secp256k1'", async () => {
    const capturedLocks: Script[] = [];
    const d = deps({
      secp256k1ScriptInfo: secp256k1ScriptInfo(),
      listCellsForLock: vi.fn(async (lock: Script) => { capturedLocks.push(lock); return [cell()]; }),
    });
    const secp256k1Source: Source = { ...source(), lockKind: "secp256k1" };
    const res = await buildAndSend(send(), secp256k1Source, new MockCkbTxSigner(), 1200n, d);
    expect(res.txHash).toBe("0xbroadcasthash");
    expect(capturedLocks[0]?.codeHash).toBe(SECP);
  });

  it("uses the JoyID lock when source.lockKind is explicitly 'joyid'", async () => {
    const capturedLocks: Script[] = [];
    const d = deps({
      listCellsForLock: vi.fn(async (lock: Script) => { capturedLocks.push(lock); return [cell()]; }),
    });
    const joyidSource: Source = { ...source(), lockKind: "joyid" };
    await buildAndSend(send(), joyidSource, new MockCkbTxSigner(), 1200n, d);
    expect(capturedLocks[0]?.codeHash).toBe(JOYID);
  });

  it("throws with a clear message when lockKind is 'secp256k1' but secp256k1ScriptInfo is missing", async () => {
    const secp256k1Source: Source = { ...source(), lockKind: "secp256k1" };
    // deps() does not include secp256k1ScriptInfo
    await expect(
      buildAndSend(send(), secp256k1Source, new MockCkbTxSigner(), 1200n, deps()),
    ).rejects.toThrow(/secp256k1ScriptInfo/);
  });
});
