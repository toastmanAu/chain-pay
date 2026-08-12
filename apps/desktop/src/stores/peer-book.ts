import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PeerProfile } from "../lib/comm/types";
import { assertNotMultisigSigner, type KnownSigner } from "../lib/comm/refusal-invariant";
import { peerHashFromAddress } from "../lib/comm/peer-hash";

export interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
  /**
   * Optional: the multisig signer pubkey hash this peer relays for. When set,
   * PayPanel routes signature requests to this peer for that slot. Each hash
   * is unique across the peer book — setting a hash already mapped to another
   * peer throws.
   */
  associatedSignerHash?: `0x${string}`;
  /** 0x-prefixed 20-byte blake160 of the peer's cemp-pq lock args (first 20
   *  bytes). Cached at add time so onIncomingAck can resolve sender → peer
   *  without recomputing. Required in v2+; v1 records are backfilled on
   *  rehydrate via peerHashFromAddress. */
  addrHash: `0x${string}`;
}

interface PeerBookStore {
  peers: Peer[];
  /**
   * Lazy accessor for known multisig signers, injected by the App at boot.
   * Tests override this via setState.
   */
  knownSignersGetter: () => readonly KnownSigner[];
  addPeer: (peer: Omit<Peer, "addrHash">, candidateHash: Uint8Array) => void;
  removePeer: (address: string) => void;
  renamePeer: (address: string, nickname: string) => void;
  setCachedProfile: (address: string, profile: PeerProfile) => void;
  findPeer: (address: string) => Peer | undefined;
  setAssociatedSignerHash: (address: string, hash: `0x${string}` | undefined) => void;
  findByAssociatedSignerHash: (hash: `0x${string}`) => Peer | undefined;
  findByAddrHash: (addrHash: `0x${string}`) => Peer | undefined;
}

function assertSignerHashFree(peers: readonly Peer[], hash: `0x${string}`): void {
  const owner = peers.find((p) => p.associatedSignerHash === hash);
  if (owner) {
    throw new Error(
      `associatedSignerHash ${hash} is already mapped to peer "${owner.nickname}" (${owner.address})`,
    );
  }
}

function bytesToHex20(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 20) {
    throw new Error(`expected 20-byte hash, got ${bytes.length}`);
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const usePeerBookStore = create<PeerBookStore>()(
  persist(
    (set, get) => ({
      peers: [],
      knownSignersGetter: () => [],
      addPeer: (peer, candidateHash) => {
        assertNotMultisigSigner(candidateHash, get().knownSignersGetter);
        if (peer.associatedSignerHash !== undefined) {
          assertSignerHashFree(get().peers, peer.associatedSignerHash);
        }
        const addrHash = bytesToHex20(candidateHash);
        set((s) => ({ peers: [...s.peers, { ...peer, addrHash }] }));
      },
      removePeer: (address) =>
        set((s) => ({ peers: s.peers.filter((p) => p.address !== address) })),
      renamePeer: (address, nickname) =>
        set((s) => ({
          peers: s.peers.map((p) => (p.address === address ? { ...p, nickname } : p)),
        })),
      setCachedProfile: (address, profile) =>
        set((s) => ({
          peers: s.peers.map((p) => (p.address === address ? { ...p, cachedProfile: profile } : p)),
        })),
      findPeer: (address) => get().peers.find((p) => p.address === address),
      setAssociatedSignerHash: (address, hash) => {
        if (hash !== undefined) {
          // Collision check ignores the peer being updated; setting your own hash
          // to itself is a no-op rather than a throw.
          const others = get().peers.filter((p) => p.address !== address);
          assertSignerHashFree(others, hash);
        }
        set((s) => ({
          peers: s.peers.map((p) => {
            if (p.address !== address) return p;
            if (hash === undefined) {
              // Strip the field rather than setting it to undefined — keeps
              // the Peer shape clean under exactOptionalPropertyTypes.
              const { associatedSignerHash: _omit, ...rest } = p;
              return rest;
            }
            return { ...p, associatedSignerHash: hash };
          }),
        }));
      },
      findByAssociatedSignerHash: (hash) =>
        get().peers.find((p) => p.associatedSignerHash === hash),
      findByAddrHash: (addrHash) =>
        get().peers.find((p) => p.addrHash === addrHash),
    }),
    {
      name: "chain-pay:peer-book",
      storage: createJSONStorage(() => storageImpl),
      version: 2,
      // Don't persist the getter — App.tsx wires it on boot.
      partialize: (state) => ({ peers: state.peers }),
      migrate: async (persisted, fromVersion) => {
        const state = persisted as { peers?: Array<Partial<Peer> & { address: string }> };
        if (!state?.peers) return { peers: [] as Peer[] };
        if (fromVersion < 2) {
          const peers: Peer[] = [];
          for (const p of state.peers) {
            try {
              const hashBytes = await peerHashFromAddress(p.address);
              const addrHash = bytesToHex20(hashBytes);
              peers.push({
                nickname: p.nickname ?? "(migrated)",
                address: p.address,
                pairedAt: p.pairedAt ?? 0,
                ...(p.cachedProfile !== undefined ? { cachedProfile: p.cachedProfile } : {}),
                ...(p.associatedSignerHash !== undefined
                  ? { associatedSignerHash: p.associatedSignerHash }
                  : {}),
                addrHash,
              });
            } catch (err) {
              console.warn(
                "[peer-book] dropped peer during v1→v2 migration:",
                p.address,
                err,
              );
            }
          }
          return { peers };
        }
        return state as { peers: Peer[] };
      },
    },
  ),
);
