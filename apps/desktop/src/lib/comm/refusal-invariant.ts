import { RefusalInvariantError } from "./errors";

export interface KnownSigner {
  treasuryId: string;
  pubkeyHash: Uint8Array;
}

/**
 * Throws RefusalInvariantError if `candidateHash` matches the blake160 of any
 * known multisig signer across all active treasuries.
 *
 * @param candidateHash 20-byte blake160 hash being checked.
 * @param getKnownSigners Lazy accessor — called only when needed so we don't
 *   pin a stale snapshot of treasury state.
 */
export function assertNotMultisigSigner(
  candidateHash: Uint8Array,
  getKnownSigners: () => readonly KnownSigner[],
): void {
  const signers = getKnownSigners();
  for (const signer of signers) {
    if (bytesEqual(candidateHash, signer.pubkeyHash)) {
      throw new RefusalInvariantError(
        toHex(candidateHash),
        `multisig signer of treasury ${signer.treasuryId}`,
      );
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // noUncheckedIndexedAccess: typed array indexing returns number | undefined.
    // We've already confirmed equal lengths so both indices are in-bounds;
    // the undefined guards below satisfy the compiler without runtime overhead.
    const aByte = a[i];
    const bByte = b[i];
    if (aByte === undefined || bByte === undefined) return false;
    if (aByte !== bByte) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
