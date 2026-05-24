import { describe, it, expect, beforeEach } from "vitest";
import { usePeerBookStore, type Peer } from "./peer-book";
import { RefusalInvariantError } from "../lib/comm/errors";

function resetStore(): void {
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  globalThis.localStorage?.removeItem("chain-pay:peer-book");
}

const PEER_A: Peer = {
  nickname: "Alice",
  address: "ckt1qalice",
  pairedAt: 1747900000_000,
};

const HASH_OF_ALICE = new Uint8Array(20).fill(0xaa);

describe("peer-book store", () => {
  beforeEach(resetStore);

  it("starts empty", () => {
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("addPeer appends", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    expect(usePeerBookStore.getState().peers).toEqual([PEER_A]);
  });

  it("addPeer throws RefusalInvariantError when peer hash matches a treasury signer", () => {
    usePeerBookStore.setState({
      knownSignersGetter: () => [{ treasuryId: "t1", pubkeyHash: HASH_OF_ALICE }],
    });
    expect(() => usePeerBookStore.getState().addPeer(PEER_A, HASH_OF_ALICE)).toThrow(
      RefusalInvariantError,
    );
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("removePeer drops by address", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().removePeer("ckt1qalice");
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("renamePeer updates nickname only", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().renamePeer("ckt1qalice", "Bob");
    expect(usePeerBookStore.getState().peers[0]!.nickname).toBe("Bob");
    expect(usePeerBookStore.getState().peers[0]!.address).toBe("ckt1qalice");
  });

  it("findPeer returns by address", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    expect(usePeerBookStore.getState().findPeer("ckt1qalice")).toEqual(PEER_A);
    expect(usePeerBookStore.getState().findPeer("ckt1qzzz")).toBeUndefined();
  });

  it("setCachedProfile attaches profile to existing peer", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    const profile = {
      address: "ckt1qalice",
      mlDsaPubKey: new Uint8Array(1952),
      mlKemPubKey: new Uint8Array(1184),
      fetchedAt: Date.now(),
    };
    usePeerBookStore.getState().setCachedProfile("ckt1qalice", profile);
    expect(usePeerBookStore.getState().peers[0]!.cachedProfile).toEqual(profile);
  });

  it("setCachedProfile no-ops for unknown address", () => {
    const profile = {
      address: "ckt1qalice",
      mlDsaPubKey: new Uint8Array(1952),
      mlKemPubKey: new Uint8Array(1184),
      fetchedAt: Date.now(),
    };
    usePeerBookStore.getState().setCachedProfile("ckt1qalice", profile);
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("removePeer no-ops for unknown address", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().removePeer("ckt1qbob");
    const peer = usePeerBookStore.getState().findPeer("ckt1qalice");
    expect(peer).toEqual(PEER_A);
  });

  it("addPeer duplicates same address are appended (caller dedupes)", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    expect(usePeerBookStore.getState().peers).toHaveLength(2);
  });
});

// ── 2.7b-2: associatedSignerHash field + mapping actions ────────────────────

const SIGNER_HASH_A = `0x${"a1".repeat(20)}` as const;
const SIGNER_HASH_B = `0x${"b2".repeat(20)}` as const;
const PEER_B: Peer = {
  nickname: "Bob",
  address: "ckt1qbob",
  pairedAt: 1747900000_000,
};

describe("peer-book store — associatedSignerHash", () => {
  beforeEach(resetStore);

  it("addPeer with associatedSignerHash persists the field", () => {
    const peer: Peer = { ...PEER_A, associatedSignerHash: SIGNER_HASH_A };
    usePeerBookStore.getState().addPeer(peer, new Uint8Array(20));
    expect(usePeerBookStore.getState().peers[0]!.associatedSignerHash).toBe(SIGNER_HASH_A);
  });

  it("addPeer rejects a duplicate associatedSignerHash", () => {
    const first: Peer = { ...PEER_A, associatedSignerHash: SIGNER_HASH_A };
    const second: Peer = { ...PEER_B, associatedSignerHash: SIGNER_HASH_A };
    usePeerBookStore.getState().addPeer(first, new Uint8Array(20));
    expect(() => usePeerBookStore.getState().addPeer(second, new Uint8Array(20))).toThrow(
      /associatedSignerHash.*already mapped/i,
    );
    expect(usePeerBookStore.getState().peers).toHaveLength(1);
  });

  it("setAssociatedSignerHash sets the field on an existing peer", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().setAssociatedSignerHash("ckt1qalice", SIGNER_HASH_A);
    expect(usePeerBookStore.getState().findPeer("ckt1qalice")!.associatedSignerHash).toBe(
      SIGNER_HASH_A,
    );
  });

  it("setAssociatedSignerHash with undefined clears the field", () => {
    const peer: Peer = { ...PEER_A, associatedSignerHash: SIGNER_HASH_A };
    usePeerBookStore.getState().addPeer(peer, new Uint8Array(20));
    usePeerBookStore.getState().setAssociatedSignerHash("ckt1qalice", undefined);
    expect(usePeerBookStore.getState().findPeer("ckt1qalice")!.associatedSignerHash).toBeUndefined();
  });

  it("findByAssociatedSignerHash returns the peer that owns the hash", () => {
    const peer: Peer = { ...PEER_A, associatedSignerHash: SIGNER_HASH_A };
    usePeerBookStore.getState().addPeer(peer, new Uint8Array(20));
    usePeerBookStore.getState().addPeer(PEER_B, new Uint8Array(20));
    expect(usePeerBookStore.getState().findByAssociatedSignerHash(SIGNER_HASH_A)?.address).toBe(
      "ckt1qalice",
    );
    expect(usePeerBookStore.getState().findByAssociatedSignerHash(SIGNER_HASH_B)).toBeUndefined();
  });
});
