import { describe, it, expect, vi, beforeEach } from "vitest";
import { CempPqCommTransport, type TransportDeps } from "./transport";
import type { PeerProfile, OutgoingPacket } from "../types";

const OWN_LOCK = { codeHash: "0xself", hashType: "type" as const, args: "0xown" };
const OWN_ADDR_HASH = new Uint8Array(20).fill(0x01);
const PEER: PeerProfile = {
  address: "ckt1qbob",
  mlDsaPubKey: new Uint8Array(1952),
  mlKemPubKey: new Uint8Array(1184).fill(0xee),
  fetchedAt: Date.now(),
};
const PACKET: OutgoingPacket = {
  txHash: "0xbatch",
  treasuryAddress: "ckt1qtreasury",
  expiresAt: 1747900000,
  packet: { kind: "transfer", payments: [] } as never,
};

function makeDeps(overrides: Partial<TransportDeps> = {}): TransportDeps {
  return {
    getOwnLock: vi.fn().mockResolvedValue(OWN_LOCK),
    getOwnAddrHash: vi.fn().mockResolvedValue(OWN_ADDR_HASH),
    getProfilePublishBlock: vi.fn().mockResolvedValue(100n),
    ipc: {
      publishProfile: vi.fn().mockResolvedValue({ txHash: "0xp", txBytes: "0xtxbytes" }),
      sendMessage: vi.fn().mockResolvedValue({ txHash: "0xs", txBytes: "0xtxbytes" }),
      decryptIncoming: vi.fn().mockResolvedValue("0xenvelope"),
      resolveProfile: vi.fn().mockResolvedValue({
        address: PEER.address,
        mlDsaPubKey: "0x" + "00".repeat(1952),
        mlKemPubKey: "0x" + "ee".repeat(1184),
        metadata: "{}",
      }),
    },
    broadcastTransaction: vi.fn().mockResolvedValue("0xb"),
    watchLockScript: vi.fn().mockResolvedValue(undefined),
    listCellsForLock: vi.fn().mockResolvedValue([]),
    parseMessagePointer: vi.fn(),
    ...overrides,
  };
}

describe("CempPqCommTransport", () => {
  it("sendPacket: encodes envelope, calls ipc.sendMessage, broadcasts", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const txHash = await t.sendPacket(PEER, PACKET);
    expect(deps.ipc.sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = (deps.ipc.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const [recipient, envelopeHex] = sendCall;
    expect(recipient).toBe(PEER.address);
    const bytes = Buffer.from(envelopeHex.slice(2), "hex");
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x01);
    expect(deps.broadcastTransaction).toHaveBeenCalledWith("0xtxbytes");
    expect(txHash).toBe("0xs");
  });

  it("sendSignature: uses signature kind byte (0x02)", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.sendSignature(PEER, { txHash: "0xb", slotIndex: 0, signature: "0xsig" });
    const sigSendCall = (deps.ipc.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const [, envelopeHex] = sigSendCall;
    expect(Buffer.from(envelopeHex.slice(2), "hex")[1]).toBe(0x02);
  });

  it("publishProfile: forwards to ipc and broadcasts", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const tx = await t.publishProfile({ displayName: "Alice" });
    expect(deps.ipc.publishProfile).toHaveBeenCalledWith({ displayName: "Alice" });
    expect(deps.broadcastTransaction).toHaveBeenCalledWith("0xtxbytes");
    expect(tx).toBe("0xp");
  });

  it("resolveProfile: caches results for 1h TTL", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const first = await t.resolveProfile(PEER.address);
    const second = await t.resolveProfile(PEER.address);
    expect(deps.ipc.resolveProfile).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("start(): seeds lastSeenBlock from profilePublishBlock", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.start();
    expect(deps.getProfilePublishBlock).toHaveBeenCalled();
    expect(deps.watchLockScript).toHaveBeenCalledWith(OWN_LOCK, 100n);
    expect(t.isRunning()).toBe(true);
    await t.stop();
  });

  it("start(): refuses when no profile published yet", async () => {
    const deps = makeDeps({ getProfilePublishBlock: vi.fn().mockResolvedValue(null) });
    const t = new CempPqCommTransport(deps);
    await expect(t.start()).rejects.toThrow(/profile/i);
  });

  it("resolveProfile: refetches after TTL expiry", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.resolveProfile(PEER.address);
    // Advance past the 1h TTL
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1000);
    await t.resolveProfile(PEER.address);
    expect(deps.ipc.resolveProfile).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("resolveProfile: wraps unknown errors in ProfileNotFoundError", async () => {
    const { ProfileNotFoundError } = await import("../errors");
    const deps = makeDeps({
      ipc: {
        publishProfile: vi.fn().mockResolvedValue({ txHash: "0xp", txBytes: "0xtxbytes" }),
        sendMessage: vi.fn().mockResolvedValue({ txHash: "0xs", txBytes: "0xtxbytes" }),
        decryptIncoming: vi.fn().mockResolvedValue("0xenvelope"),
        resolveProfile: vi.fn().mockRejectedValue(new Error("rpc error")),
      },
    });
    const t = new CempPqCommTransport(deps);
    await expect(t.resolveProfile("ckt1qunknown")).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it("onIncomingPacket throws when transport not started", () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    expect(() => t.onIncomingPacket(() => {})).toThrow(/not started/i);
  });

  it("sendPacket: encodes sender_addr_hash exactly as returned by getOwnAddrHash", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.sendPacket(PEER, PACKET);
    const hashSendCall = (deps.ipc.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const [, envelopeHex] = hashSendCall;
    const bytes = Buffer.from(envelopeHex.slice(2), "hex");
    const encodedHash = bytes.slice(2, 22);
    expect(Array.from(encodedHash)).toEqual(Array.from(OWN_ADDR_HASH));
  });

  it("start() is idempotent", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.start();
    await t.start();
    expect(deps.watchLockScript).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  it("stop() is idempotent", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.start();
    await t.stop();
    await t.stop();
    expect(t.isRunning()).toBe(false);
  });

  it("isRunning() reflects watcher lifecycle", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    expect(t.isRunning()).toBe(false);
    await t.start();
    expect(t.isRunning()).toBe(true);
    await t.stop();
    expect(t.isRunning()).toBe(false);
  });

  it("publishProfile returns the tx hash from ipc", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const result = await t.publishProfile({});
    expect(result).toBe("0xp");
  });

  it("resolveProfile passes through metadata.displayName", async () => {
    const deps = makeDeps({
      ipc: {
        publishProfile: vi.fn().mockResolvedValue({ txHash: "0xp", txBytes: "0xtxbytes" }),
        sendMessage: vi.fn().mockResolvedValue({ txHash: "0xs", txBytes: "0xtxbytes" }),
        decryptIncoming: vi.fn().mockResolvedValue("0xenvelope"),
        resolveProfile: vi.fn().mockResolvedValue({
          address: PEER.address,
          mlDsaPubKey: "0x" + "00".repeat(1952),
          mlKemPubKey: "0x" + "ee".repeat(1184),
          metadata: '{"displayName":"Alice"}',
        }),
      },
    });
    const t = new CempPqCommTransport(deps);
    const profile = await t.resolveProfile(PEER.address);
    expect(profile.metadata?.displayName).toBe("Alice");
  });
});
