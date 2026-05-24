import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PeerProfile } from "../lib/comm/types";
import { assertNotMultisigSigner, type KnownSigner } from "../lib/comm/refusal-invariant";

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
}

interface PeerBookStore {
  peers: Peer[];
  /**
   * Lazy accessor for known multisig signers, injected by the App at boot.
   * Tests override this via setState.
   */
  knownSignersGetter: () => readonly KnownSigner[];
  addPeer: (peer: Peer, candidateHash: Uint8Array) => void;
  removePeer: (address: string) => void;
  renamePeer: (address: string, nickname: string) => void;
  setCachedProfile: (address: string, profile: PeerProfile) => void;
  findPeer: (address: string) => Peer | undefined;
  setAssociatedSignerHash: (address: string, hash: `0x${string}` | undefined) => void;
  findByAssociatedSignerHash: (hash: `0x${string}`) => Peer | undefined;
}

function assertSignerHashFree(peers: readonly Peer[], hash: `0x${string}`): void {
  const owner = peers.find((p) => p.associatedSignerHash === hash);
  if (owner) {
    throw new Error(
      `associatedSignerHash ${hash} is already mapped to peer "${owner.nickname}" (${owner.address})`,
    );
  }
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
        set((s) => ({ peers: [...s.peers, peer] }));
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
    }),
    {
      name: "chain-pay:peer-book",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      // Don't persist the getter — App.tsx wires it on boot.
      partialize: (state) => ({ peers: state.peers }),
    },
  ),
);
