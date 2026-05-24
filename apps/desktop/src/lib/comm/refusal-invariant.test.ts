import { describe, it, expect } from "vitest";
import { assertNotMultisigSigner } from "./refusal-invariant";
import { RefusalInvariantError } from "./errors";

const HASH_A = new Uint8Array(20).fill(0xaa);
const HASH_B = new Uint8Array(20).fill(0xbb);
const HASH_C = new Uint8Array(20).fill(0xcc);

const knownSignersEmpty = () => [];
const knownSignersWithA = () => [{ treasuryId: "t1", pubkeyHash: HASH_A }];
const knownSignersMulti = () => [
  { treasuryId: "t1", pubkeyHash: HASH_A },
  { treasuryId: "t2", pubkeyHash: HASH_B },
];

describe("refusal invariant", () => {
  it("passes when no treasury exists", () => {
    expect(() => assertNotMultisigSigner(HASH_A, knownSignersEmpty)).not.toThrow();
  });

  it("passes when hash matches no signer", () => {
    expect(() => assertNotMultisigSigner(HASH_C, knownSignersMulti)).not.toThrow();
  });

  it("throws RefusalInvariantError when hash matches a signer", () => {
    expect(() => assertNotMultisigSigner(HASH_A, knownSignersWithA)).toThrow(RefusalInvariantError);
  });

  it("identifies the conflicting treasury in the error", () => {
    try {
      assertNotMultisigSigner(HASH_B, knownSignersMulti);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RefusalInvariantError);
      expect((e as RefusalInvariantError).conflict).toContain("t2");
    }
  });

  it("compares bytes, not hex strings", () => {
    const dup = new Uint8Array(HASH_A);
    expect(() =>
      assertNotMultisigSigner(dup, () => [{ treasuryId: "t1", pubkeyHash: HASH_A }]),
    ).toThrow(RefusalInvariantError);
  });

  it("only checks the snapshot at call time", () => {
    let callCount = 0;
    const accessor = () => {
      callCount++;
      return [{ treasuryId: "t1", pubkeyHash: HASH_A }];
    };
    // Call assertNotMultisigSigner once — accessor should be called exactly once
    try {
      assertNotMultisigSigner(HASH_A, accessor);
    } catch {
      // expected to throw
    }
    expect(callCount).toBe(1);
    // Second independent call — accessor called exactly once more
    callCount = 0;
    expect(() => assertNotMultisigSigner(HASH_C, accessor)).not.toThrow();
    expect(callCount).toBe(1);
  });

  it("handles many signers efficiently", () => {
    const signers = Array.from({ length: 1000 }, (_, i) => {
      const hash = new Uint8Array(20).fill(0xaa);
      hash[19] = i % 256;
      return { treasuryId: `t${i}`, pubkeyHash: hash };
    });
    // Candidate that's not in the set (last byte 0x00 conflicts with i=0 entry, use 0xff)
    const notInSet = new Uint8Array(20).fill(0xcc);
    const start = performance.now();
    expect(() => assertNotMultisigSigner(notInSet, () => signers)).not.toThrow();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("differentiates HASH_A from HASH_A-1 (last byte differs)", () => {
    const HASH_A_VARIANT = new Uint8Array(20).fill(0xaa);
    HASH_A_VARIANT[19] = 0xa9;
    expect(() => assertNotMultisigSigner(HASH_A_VARIANT, knownSignersWithA)).not.toThrow();
  });
});
