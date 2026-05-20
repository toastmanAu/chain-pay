import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesConcat, bytesFrom, hexFrom, HasherCkb, numBeToBytes, type Hex } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";

/**
 * Sign a 32-byte digest with a secp256k1 private key, producing the 65-byte
 * recoverable signature CKB expects:
 *
 *   r(32) || s(32) || v(1)        with v ∈ {0, 1}
 *
 * Same wire format as Ethereum but without the +27 v offset.
 *
 * Matches CCC's SignerCkbPrivateKey._signMessage byte-for-byte.
 */
export function signDigest(digestHex: string, privateKeyHex: string): Hex {
  const digest = bytesFrom(digestHex);
  const privateKey = bytesFrom(privateKeyHex);
  if (digest.length !== 32) {
    throw new Error(`digest must be 32 bytes, got ${digest.length}`);
  }
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  const { r, s, recovery } = secp256k1.sign(digest, privateKey);
  return hexFrom(
    bytesConcat(numBeToBytes(r, 32), numBeToBytes(s, 32), numBeToBytes(recovery, 1)),
  );
}

/** Return the compressed (33-byte) secp256k1 public key for a private key. */
export function compressedPubkeyFromPrivateKey(privateKeyHex: string): Hex {
  const privateKey = bytesFrom(privateKeyHex);
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  return hexFrom(secp256k1.getPublicKey(privateKey, true));
}

/**
 * Compute the CKB blake160 pubkey hash for a private key. This is what gets
 * embedded in `secp256k1_blake160_multisig_all` lock args / pubkeyHashes.
 */
export function pubkeyHashFromPrivateKey(privateKeyHex: string): Hex20 {
  const pubkey = bytesFrom(compressedPubkeyFromPrivateKey(privateKeyHex));
  return new HasherCkb(20).update(pubkey).digest() as Hex20;
}

/**
 * Verify a CKB-format (r || s || v) signature against an expected compressed
 * public key. Returns true iff the signature recovers to that key.
 *
 * Useful for round-trip tests and for the signer UI to confirm a freshly-
 * produced sig matches the expected co-signer pubkey hash before sending it
 * for partial-sig collection.
 */
export function verifyDigestSignature(
  digestHex: string,
  signatureHex: string,
  expectedCompressedPubkey: string,
): boolean {
  const digest = bytesFrom(digestHex);
  const sigBytes = bytesFrom(signatureHex);
  if (sigBytes.length !== 65) return false;

  const r = bytesToBigint(sigBytes.slice(0, 32));
  const s = bytesToBigint(sigBytes.slice(32, 64));
  const recovery = sigBytes[64];
  if (recovery === undefined || recovery > 1) return false;

  try {
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(recovery);
    const recovered = sig.recoverPublicKey(digest).toRawBytes(true);
    const expected = bytesFrom(expectedCompressedPubkey);
    if (recovered.length !== expected.length) return false;
    for (let i = 0; i < recovered.length; i++) {
      if (recovered[i] !== expected[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
