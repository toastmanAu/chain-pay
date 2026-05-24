import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWatcher, type WatcherDeps } from "./watcher";
import { encodeEnvelope } from "../envelope";

const SENDER_HASH = new Uint8Array(20).fill(0xab);
const OWN_LOCK = { codeHash: "0xself", hashType: "type" as const, args: "0x01" };

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    ownLock: OWN_LOCK,
    listCellsForLock: vi.fn().mockResolvedValue([]),
    decryptIncoming: vi.fn().mockRejectedValue(new Error("no cell")),
    parseMessagePointer: vi.fn().mockReturnValue({ txHash: "0xm", index: 0 }),
    ...overrides,
  };
}

describe("watcher", () => {
  beforeEach(() => vi.useFakeTimers());

  it("starts polling on start()", async () => {
    const deps = makeDeps();
    const w = createWatcher(deps);
    await w.start();
    expect(deps.listCellsForLock).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("dispatches packet kind to onIncomingPacket", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xdeadbeef" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onPacket = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(onPacket);
    // start() awaits an initial poll() synchronously, so dispatch happens before start() returns
    await w.start();
    expect(onPacket).toHaveBeenCalledTimes(1);
    expect(onPacket).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ txHash: "0xtx" }));
    await w.stop();
  });

  it("dedups cells already processed", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "signature",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", slotIndex: 0, signature: "0xsig" },
    });
    const cell = { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" };
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValue([cell]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onSig = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingSignature(onSig);
    // start() polls once; same cell returned again on second manual poll
    await w.start();
    // Second explicit poll — same cell, should not re-dispatch.
    await w.poll();
    expect(onSig).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("silently drops cells whose envelope fails to decrypt", async () => {
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockRejectedValue(new Error("AES tag mismatch")),
    });
    const onPacket = vi.fn();
    const onSig = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(onPacket);
    w.onIncomingSignature(onSig);
    await w.start();
    expect(onPacket).not.toHaveBeenCalled();
    expect(onSig).not.toHaveBeenCalled();
    await w.stop();
  });

  it("unsubscribe removes the handler", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onPacket = vi.fn();
    const w = createWatcher(deps);
    const off = w.onIncomingPacket(onPacket);
    off(); // unsubscribe before start
    await w.start();
    expect(onPacket).not.toHaveBeenCalled();
    await w.stop();
  });

  it("survives a listCellsForLock rejection", async () => {
    const deps = makeDeps({
      listCellsForLock: vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue([]),
    });
    const w = createWatcher(deps);
    // Should not throw on first call (rejection)
    await expect(w.start()).resolves.toBeUndefined();
    // Watcher still usable — second poll also resolves
    await expect(w.poll()).resolves.toBeUndefined();
    expect(deps.listCellsForLock).toHaveBeenCalledTimes(2);
    await w.stop();
  });

  it("drops envelope with unknown kind silently", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    // Mutate the kind byte (index 1) to an unknown value
    const mutated = new Uint8Array(envelopeBytes);
    mutated[1] = 0xff;
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(mutated).toString("hex")),
    });
    const onPacket = vi.fn();
    const onSig = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(onPacket);
    w.onIncomingSignature(onSig);
    await w.start();
    expect(onPacket).not.toHaveBeenCalled();
    expect(onSig).not.toHaveBeenCalled();
    await w.stop();
  });

  it("clears interval timer on stop()", async () => {
    const deps = makeDeps();
    const w = createWatcher(deps);
    await w.start();
    expect(w.isRunning()).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await w.stop();
    expect(w.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispatches to multiple handlers", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(handler1);
    w.onIncomingPacket(handler2);
    await w.start();
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    await w.stop();
  });
});
