import { describe, expect, it } from "vitest";
import { Cell, OutPoint, Script } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";
import {
  SECP256K1_BLAKE160_CODE_HASH,
  buildPaymentSkeleton,
  minCapacityForLock,
  treasuryCellDep,
} from "./tx-builder";
import { treasuryLockScript } from "./address";
import type { CkbMultisigConfig } from "./multisig";

const hash1 = ("0x" + "11".repeat(20)) as Hex20;
const hash2 = ("0x" + "22".repeat(20)) as Hex20;
const hash3 = ("0x" + "33".repeat(20)) as Hex20;

const cfg: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash1, hash2, hash3],
};

const treasuryScript = Script.from(treasuryLockScript(cfg));

// Plain secp256k1_blake160 lock (single-sig payee).
const payeeScript = Script.from({
  codeHash: SECP256K1_BLAKE160_CODE_HASH,
  hashType: "type",
  args: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

// 1 CKB = 10^8 shannons.
const CKB = 100_000_000n;

function makeCell(capacity: bigint, lock: Script, txHashByte = "00", index = 0): Cell {
  return Cell.from({
    outPoint: OutPoint.from({
      txHash: "0x" + txHashByte.repeat(32),
      index,
    }),
    cellOutput: { capacity, lock, type: null },
    outputData: "0x",
  });
}

describe("minCapacityForLock", () => {
  it("computes 61 CKB for the V1 multisig lock with 20-byte args", () => {
    const cap = minCapacityForLock(treasuryScript);
    expect(cap).toBe(61n * CKB);
  });

  it("computes 69 CKB for a multisig lock with 28-byte args (time-locked)", () => {
    const tlScript = Script.from(treasuryLockScript({ ...cfg, since: 0x4000000000000000n }));
    expect(minCapacityForLock(tlScript)).toBe(69n * CKB);
  });
});

describe("treasuryCellDep", () => {
  it("returns mainnet V1 multisig cell dep", () => {
    const dep = treasuryCellDep("mainnet");
    expect(dep.depType).toBe("depGroup");
    expect(dep.outPoint.txHash).toBe(
      "0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c",
    );
  });

  it("returns testnet V1 multisig cell dep", () => {
    const dep = treasuryCellDep("testnet");
    expect(dep.outPoint.txHash).toBe(
      "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
    );
  });
});

describe("buildPaymentSkeleton", () => {
  it("builds a tx with 1 input, 2 outputs (recipient + change), and the multisig cell dep", () => {
    // Input: 200 CKB. Recipient: 70 CKB. Change: ~130 CKB (well above 61 min).
    const cells = [makeCell(200n * CKB, treasuryScript, "01")];
    const result = buildPaymentSkeleton({
      treasuryConfig: cfg,
      treasuryScript,
      recipients: [{ lock: payeeScript, capacity: 70n * CKB }],
      availableCells: cells,
      network: "testnet",
      feeRateShannonsPerByte: 1000n,
    });

    expect(result.tx.inputs.length).toBe(1);
    expect(result.tx.outputs.length).toBe(2); // recipient + change
    expect(result.tx.outputs[0]?.capacity).toBe(70n * CKB);
    expect(result.tx.outputs[1]?.lock.codeHash).toBe(treasuryScript.codeHash);
    expect(result.tx.cellDeps.length).toBe(1);
    expect(result.totalIn).toBe(200n * CKB);
    expect(result.totalOut).toBe(70n * CKB + result.change);
    expect(result.fee).toBeGreaterThan(0n);
    expect(result.change).toBeGreaterThanOrEqual(61n * CKB);
  });

  it("selects multiple cells when one isn't enough", () => {
    const cells = [
      makeCell(50n * CKB, treasuryScript, "01"),
      makeCell(80n * CKB, treasuryScript, "02"),
    ];
    const result = buildPaymentSkeleton({
      treasuryConfig: cfg,
      treasuryScript,
      recipients: [{ lock: payeeScript, capacity: 100n * CKB }],
      availableCells: cells,
      network: "testnet",
      feeRateShannonsPerByte: 1000n,
    });
    expect(result.tx.inputs.length).toBe(2);
  });

  it("pre-pads witness[0] with the multisig placeholder (M × 65-byte sig slots)", () => {
    const cells = [makeCell(100n * CKB, treasuryScript, "01")];
    const result = buildPaymentSkeleton({
      treasuryConfig: cfg,
      treasuryScript,
      recipients: [{ lock: payeeScript, capacity: 70n * CKB }],
      availableCells: cells,
      network: "testnet",
      feeRateShannonsPerByte: 1000n,
    });
    // Witness[0] is a WitnessArgs molecule. The `lock` field is multisig_script + 2 × 65 zeros.
    // We can't easily decode molecule here, but the witness must be non-empty and >= raw size.
    const witness0 = result.tx.witnesses[0];
    expect(witness0).toBeDefined();
    // Expected raw lock bytes: 4 (header) + 60 (3 hashes) + 130 (2 sigs) = 194.
    // Molecule WitnessArgs envelope adds ~16 bytes overhead (table headers + offset).
    const expectedMinSize = 4 + 60 + 130;
    expect((witness0!.length - 2) / 2).toBeGreaterThanOrEqual(expectedMinSize);
  });

  it("throws if available cells can't cover outputs + fee", () => {
    const cells = [makeCell(50n * CKB, treasuryScript, "01")];
    expect(() =>
      buildPaymentSkeleton({
        treasuryConfig: cfg,
        treasuryScript,
        recipients: [{ lock: payeeScript, capacity: 100n * CKB }],
        availableCells: cells,
        network: "testnet",
        feeRateShannonsPerByte: 1000n,
      }),
    ).toThrow(/insufficient/i);
  });

  it("throws if a recipient amount is below its min capacity", () => {
    const cells = [makeCell(100n * CKB, treasuryScript, "01")];
    expect(() =>
      buildPaymentSkeleton({
        treasuryConfig: cfg,
        treasuryScript,
        // 50 CKB to a secp256k1 lock — min is 61 CKB.
        recipients: [{ lock: payeeScript, capacity: 50n * CKB }],
        availableCells: cells,
        network: "testnet",
        feeRateShannonsPerByte: 1000n,
      }),
    ).toThrow(/min capacity/i);
  });

  it("drops the change output when remainder is below treasury's min capacity (gives it to fee)", () => {
    // Treasury has exactly 70 CKB + (61 CKB min change - 1 shannon). Change can't form, so it
    // gets folded into fee.
    const inputCap = 70n * CKB + (61n * CKB - 1n);
    const cells = [makeCell(inputCap, treasuryScript, "01")];
    const result = buildPaymentSkeleton({
      treasuryConfig: cfg,
      treasuryScript,
      recipients: [{ lock: payeeScript, capacity: 70n * CKB }],
      availableCells: cells,
      network: "testnet",
      feeRateShannonsPerByte: 1000n,
    });
    expect(result.tx.outputs.length).toBe(1); // just the recipient
    expect(result.change).toBe(0n);
    expect(result.fee).toBe(inputCap - 70n * CKB); // everything left is fee
  });

  it("requires at least one recipient", () => {
    const cells = [makeCell(100n * CKB, treasuryScript, "01")];
    expect(() =>
      buildPaymentSkeleton({
        treasuryConfig: cfg,
        treasuryScript,
        recipients: [],
        availableCells: cells,
        network: "testnet",
        feeRateShannonsPerByte: 1000n,
      }),
    ).toThrow(/recipient/i);
  });
});
