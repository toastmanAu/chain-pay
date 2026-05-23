import { useCommIdentityStore } from "../../stores/comm-identity";

/**
 * Returns the 20-byte hash of the current comm identity's address, suitable
 * for comparison against CKB multisig signer pubkey hashes (blake160).
 * Returns null if no identity is set.
 *
 * In 2.7a the address derivation is async (requires a CCC client). The
 * identity record stores the raw ML-DSA address, not a pre-parsed blake160.
 * For the 2.7a test suite, callers override via setOwnIdentityHashGetterForTests.
 * Production code in 2.7b will extend this with a cached parsed representation.
 */
let getterOverride: (() => Uint8Array | null) | null = null;

/**
 * Override the hash getter for deterministic unit tests.
 * Pass null to restore default behaviour.
 */
export function setOwnIdentityHashGetterForTests(fn: (() => Uint8Array | null) | null): void {
  getterOverride = fn;
}

/**
 * Returns the 20-byte comm-identity hash, or null if:
 * - No identity is configured, OR
 * - No test override is set and parsing would require an async CCC client.
 */
export function getOwnIdentityHash(): Uint8Array | null {
  if (getterOverride) return getterOverride();
  const identity = useCommIdentityStore.getState().identity;
  if (!identity) return null;
  // Full sync address→blake160 derivation requires CCC client (async, not available here).
  // Returns null until 2.7b caches the parsed hash on the identity record at creation time.
  return null;
}
