import { describe, it, expect, beforeEach } from "vitest";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { useIncomingPacketsStore, type IncomingPacketEntry } from "./incoming-packets";

const DIGEST_A = `0x${"a1".repeat(32)}`;
const DIGEST_B = `0x${"b2".repeat(32)}`;
const SENDER_A = `0x${"aa".repeat(20)}`;

function makePacket(sighash: string, expiresAt = 9_999_999_999): OutgoingPacket {
  return {
    txHash: sighash,
    treasuryAddress: "ckt1qtreasury",
    expiresAt,
    packet: "encoded" as TransferPacket,
  };
}

function entry(overrides: Partial<IncomingPacketEntry> = {}): IncomingPacketEntry {
  return {
    sighashDigest: DIGEST_A,
    packet: makePacket(DIGEST_A),
    senderAddrHash: SENDER_A,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function reset(): void {
  useIncomingPacketsStore.setState({ bySighash: {} });
  globalThis.localStorage?.removeItem("chain-pay:incoming-packets");
}

describe("incoming-packets store", () => {
  beforeEach(reset);

  it("starts empty", () => {
    expect(useIncomingPacketsStore.getState().bySighash).toEqual({});
  });

  it("enqueue adds an entry under its sighashDigest", () => {
    const e = entry();
    useIncomingPacketsStore.getState().enqueue(e);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toEqual(e);
  });

  it("enqueue with duplicate sighashDigest — later entry wins", () => {
    const first = entry({ receivedAt: 100 });
    const second = entry({ receivedAt: 200 });
    useIncomingPacketsStore.getState().enqueue(first);
    useIncomingPacketsStore.getState().enqueue(second);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toEqual(second);
  });

  it("dismiss removes the entry", () => {
    useIncomingPacketsStore.getState().enqueue(entry());
    useIncomingPacketsStore.getState().dismiss(DIGEST_A);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
  });

  it("dismiss on a missing key is a no-op", () => {
    useIncomingPacketsStore.getState().dismiss(DIGEST_B);
    expect(useIncomingPacketsStore.getState().bySighash).toEqual({});
  });

  it("pruneExpired drops entries whose packet.expiresAt has passed", () => {
    const now = 1_700_000_000_000;
    const oldEntry = entry({ packet: makePacket(DIGEST_A, 100) });
    const futureEntry = entry({
      sighashDigest: DIGEST_B,
      packet: makePacket(DIGEST_B, Math.floor(now / 1000) + 3600),
    });
    useIncomingPacketsStore.getState().enqueue(oldEntry);
    useIncomingPacketsStore.getState().enqueue(futureEntry);
    useIncomingPacketsStore.getState().pruneExpired(now);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_B]).toBeDefined();
  });

  it("multiple senders for different digests coexist", () => {
    useIncomingPacketsStore.getState().enqueue(entry());
    useIncomingPacketsStore
      .getState()
      .enqueue(entry({ sighashDigest: DIGEST_B, packet: makePacket(DIGEST_B), senderAddrHash: `0x${"bb".repeat(20)}` }));
    expect(Object.keys(useIncomingPacketsStore.getState().bySighash)).toHaveLength(2);
  });

  it("pruneExpired keeps an entry whose expiresAt equals nowSec (strict-gt boundary)", () => {
    const now = 1_700_000_000_000;
    const boundaryEntry = entry({ packet: makePacket(DIGEST_A, Math.floor(now / 1000)) });
    useIncomingPacketsStore.getState().enqueue(boundaryEntry);
    useIncomingPacketsStore.getState().pruneExpired(now);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toBeDefined();
  });

  it("getAll returns every entry in the bySighash map", () => {
    const e1 = entry();
    const e2 = entry({ sighashDigest: DIGEST_B, packet: makePacket(DIGEST_B) });
    useIncomingPacketsStore.getState().enqueue(e1);
    useIncomingPacketsStore.getState().enqueue(e2);
    const all = useIncomingPacketsStore.getState().getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.sighashDigest).sort()).toEqual([DIGEST_A, DIGEST_B].sort());
  });
});
