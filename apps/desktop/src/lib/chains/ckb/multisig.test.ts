import { describe, expect, it } from "vitest";
import { HasherCkb } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";
import {
  type CkbMultisigConfig,
  encodeMultisigScript,
  lockArgsFromConfig,
  placeholderWitnessLock,
} from "./multisig";

// Hand-built reference 2-of-3 config with synthetic pubkey hashes.
// header = S(00) R(00) M(02) N(03) | hash1 | hash2 | hash3
const hash1 = ("0x" + "11".repeat(20)) as Hex20;
const hash2 = ("0x" + "22".repeat(20)) as Hex20;
const hash3 = ("0x" + "33".repeat(20)) as Hex20;

const cfg2of3: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash1, hash2, hash3],
};

const expectedScript2of3 = hexToBytes(
  "0x00000203" +
    "1111111111111111111111111111111111111111" +
    "2222222222222222222222222222222222222222" +
    "3333333333333333333333333333333333333333",
);

describe("encodeMultisigScript", () => {
  it("produces 4-byte header (S|R|M|N) followed by concatenated pubkey hashes", () => {
    const { multisigScript } = encodeMultisigScript(cfg2of3);
    expect(bytesToHex(multisigScript)).toBe(bytesToHex(expectedScript2of3));
    expect(multisigScript.length).toBe(4 + 20 * 3);
  });

  it("computes scriptHash20 as blake160 of the script bytes", () => {
    const { multisigScript, scriptHash20 } = encodeMultisigScript(cfg2of3);
    expect(scriptHash20).toBe(blake160(multisigScript));
  });

  it("supports R > 0 (required signers prefix)", () => {
    const { multisigScript } = encodeMultisigScript({ ...cfg2of3, r: 1 });
    expect(multisigScript[0]).toBe(0); // S
    expect(multisigScript[1]).toBe(1); // R
    expect(multisigScript[2]).toBe(2); // M
    expect(multisigScript[3]).toBe(3); // N
  });

  it("rejects S != 0", () => {
    expect(() => encodeMultisigScript({ ...cfg2of3, s: 1 as unknown as 0 })).toThrow(/S/);
  });

  it("rejects M < 1", () => {
    expect(() => encodeMultisigScript({ ...cfg2of3, m: 0 })).toThrow(/M/);
  });

  it("rejects M > N", () => {
    expect(() => encodeMultisigScript({ ...cfg2of3, m: 4, n: 3 })).toThrow(/M.*N|threshold/i);
  });

  it("rejects R > M", () => {
    expect(() => encodeMultisigScript({ ...cfg2of3, r: 3, m: 2 })).toThrow(/R.*M|required/i);
  });

  it("rejects pubkeyHashes.length !== N", () => {
    expect(() => encodeMultisigScript({ ...cfg2of3, n: 4 })).toThrow(/N|hash/i);
  });

  it("rejects N > 255 (single-byte overflow)", () => {
    const tooMany = Array.from({ length: 256 }, () => hash1) as Hex20[];
    expect(() =>
      encodeMultisigScript({ s: 0, r: 0, m: 1, n: 256, pubkeyHashes: tooMany }),
    ).toThrow(/255|overflow/i);
  });

  it("rejects pubkey hashes that aren't exactly 20 bytes", () => {
    const shortHash = "0x1122" as Hex20;
    expect(() =>
      encodeMultisigScript({ ...cfg2of3, pubkeyHashes: [shortHash, hash2, hash3] }),
    ).toThrow(/20/);
  });
});

describe("lockArgsFromConfig", () => {
  it("returns blake160(multisig_script) for non-time-locked config (20 bytes)", () => {
    const args = lockArgsFromConfig(cfg2of3);
    expect(args.length).toBe(20);
    expect(bytesToHex(args)).toBe(blake160(expectedScript2of3));
  });

  it("appends 8-byte little-endian since for time-locked config (28 bytes)", () => {
    const since = 0x4000000000000064n; // arbitrary RFC-0017 since value
    const args = lockArgsFromConfig({ ...cfg2of3, since });
    expect(args.length).toBe(28);
    const expectedSince = u64LE(since);
    expect(bytesToHex(args.slice(0, 20))).toBe(blake160(expectedScript2of3));
    expect(bytesToHex(args.slice(20))).toBe(bytesToHex(expectedSince));
  });

  it("rejects since values that exceed u64", () => {
    expect(() => lockArgsFromConfig({ ...cfg2of3, since: 1n << 64n })).toThrow(/since|u64/i);
  });
});

describe("placeholderWitnessLock", () => {
  it("emits multisig_script followed by M × 65 zero bytes", () => {
    const lock = placeholderWitnessLock(cfg2of3);
    const expectedLen = expectedScript2of3.length + 65 * cfg2of3.m;
    expect(lock.length).toBe(expectedLen);
    expect(bytesToHex(lock.slice(0, expectedScript2of3.length))).toBe(bytesToHex(expectedScript2of3));
    const sigSlots = lock.slice(expectedScript2of3.length);
    expect(sigSlots.every((byte) => byte === 0)).toBe(true);
  });

  it("placeholder size depends on M, not N", () => {
    // 1-of-5 has a larger script (5 hashes) but only one sig slot
    const oneOfFive: CkbMultisigConfig = {
      s: 0,
      r: 0,
      m: 1,
      n: 5,
      pubkeyHashes: [hash1, hash2, hash3, hash1, hash2],
    };
    const lock = placeholderWitnessLock(oneOfFive);
    expect(lock.length).toBe(4 + 20 * 5 + 65 * 1);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function blake160(data: Uint8Array): string {
  // CKB blake160 = first 20 bytes of blake2b-256, NOT blake2b(outlen=20).
  const full = new HasherCkb(32).update(data).digest();
  return "0x" + full.slice(2, 42);
}

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
