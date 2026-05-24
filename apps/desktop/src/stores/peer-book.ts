import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PeerProfile } from "../lib/comm/types";
import { assertNotMultisigSigner, type KnownSigner } from "../lib/comm/refusal-invariant";

export interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
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
