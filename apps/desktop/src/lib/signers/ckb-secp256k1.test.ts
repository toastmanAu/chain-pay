import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves-v1/secp256k1.js";
import { HasherCkb } from "@ckb-ccc/core";
import {
  compressedPubkeyFromPrivateKey,
  pubkeyHashFromPrivateKey,
  signDigest,
  verifyDigestSignature,
} from "./ckb-secp256k1";

// Known fixture: a generated private key. Don't reuse outside tests.
const TEST_PRIVKEY = "0x4242424242424242424242424242424242424242424242424242424242424242";
const TEST_DIGEST = "0x" + "ab".repeat(32);

describe("signDigest", () => {
  it("produces a 65-byte recoverable signature (r || s || v) in CKB convention", () => {
    const sig = signDigest(TEST_DIGEST, TEST_PRIVKEY);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes
    // Last byte is the recovery id, must be 0 or 1.
    const recovery = parseInt(sig.slice(-2), 16);
    expect(recovery === 0 || recovery === 1).toBe(true);
  });

  it("is deterministic for the same (privkey, digest) input", () => {
    expect(signDigest(TEST_DIGEST, TEST_PRIVKEY)).toBe(signDigest(TEST_DIGEST, TEST_PRIVKEY));
  });

  it("recovers to the correct public key", () => {
    const sig = signDigest(TEST_DIGEST, TEST_PRIVKEY);
    const expected = compressedPubkeyFromPrivateKey(TEST_PRIVKEY);
    expect(verifyDigestSignature(TEST_DIGEST, sig, expected)).toBe(true);
  });

  it("rejects private keys that aren't 32 bytes", () => {
    expect(() => signDigest(TEST_DIGEST, "0x4242")).toThrow(/32 bytes/);
  });

  it("rejects digests that aren't 32 bytes", () => {
    expect(() => signDigest("0x4242", TEST_PRIVKEY)).toThrow(/32 bytes/);
  });
});

describe("pubkeyHashFromPrivateKey", () => {
  it("returns blake160(compressed pubkey) as a 20-byte hex", () => {
    const hash = pubkeyHashFromPrivateKey(TEST_PRIVKEY);
    expect(hash).toMatch(/^0x[0-9a-f]{40}$/);

    // Independent reference: derive pubkey from secp256k1 and blake160 ourselves.
    // CKB blake160 = first 20 bytes of blake2b-256, NOT blake2b(outlen=20).
    const pubkey = secp256k1.getPublicKey(stripHex(TEST_PRIVKEY), true);
    const full = new HasherCkb(32).update(pubkey).digest();
    const expected = "0x" + full.slice(2, 42);
    expect(hash).toBe(expected);
  });

  it("different keys → different hashes (collision sanity)", () => {
    const other = "0x" + "33".repeat(32);
    expect(pubkeyHashFromPrivateKey(TEST_PRIVKEY)).not.toBe(pubkeyHashFromPrivateKey(other));
  });
});

describe("verifyDigestSignature", () => {
  it("returns false when sig doesn't match the digest", () => {
    const sig = signDigest(TEST_DIGEST, TEST_PRIVKEY);
    const wrongDigest = "0x" + "cd".repeat(32);
    const pubkey = compressedPubkeyFromPrivateKey(TEST_PRIVKEY);
    expect(verifyDigestSignature(wrongDigest, sig, pubkey)).toBe(false);
  });

  it("returns false when sig was produced by a different key", () => {
    const sig = signDigest(TEST_DIGEST, TEST_PRIVKEY);
    const otherPubkey = compressedPubkeyFromPrivateKey("0x" + "33".repeat(32));
    expect(verifyDigestSignature(TEST_DIGEST, sig, otherPubkey)).toBe(false);
  });
});

function stripHex(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
