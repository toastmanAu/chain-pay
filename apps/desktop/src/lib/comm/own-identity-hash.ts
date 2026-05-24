import { useCommIdentityStore } from "../../stores/comm-identity";

/**
 * Returns the 20-byte hash of the current comm identity's address, suitable
 * for comparison against CKB multisig signer pubkey hashes (blake160).
 * Returns null if no identity is set.
 *
 * Reads from the cached `addrHash` field on the identity record (computed
 * at keygen time in the main process — see comm-transport-service.ts).
 * Tests may override via setOwnIdentityHashGetterForTests.
 */
let getterOverride: (() => Uint8Array | null) | null = null;

/**
 * Override the hash getter for deterministic unit tests.
 * Pass null to restore default behaviour.
 */
export function setOwnIdentityHashGetterForTests(fn: (() => Uint8Array | null) | null): void {
  getterOverride = fn;
}

export function getOwnIdentityHash(): Uint8Array | null {
  if (getterOverride) return getterOverride();
  const identity = useCommIdentityStore.getState().identity;
  if (!identity?.addrHash) return null;
  return hexToBytes(identity.addrHash);
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
