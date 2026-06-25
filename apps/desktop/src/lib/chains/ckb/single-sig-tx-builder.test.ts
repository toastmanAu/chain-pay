import { describe, it, expect } from "vitest";
import { Cell, CellDep, Script, hexFrom } from "@ckb-ccc/core";
import {
  buildSingleSigSend,
  JOYID_WITNESS_PLACEHOLDER_BYTES,
  type SingleSigSendInput,
} from "./single-sig-tx-builder";
import { minCapacityForLock } from "./tx-builder";

const JOYID = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

function joyidLock(): Script {
  return Script.from({ codeHash: JOYID, hashType: "type", args: "0x" + "11".repeat(20) });
}
function payeeLock(): Script {
  return Script.from({ codeHash: SECP, hashType: "type", args: "0x" + "22".repeat(20) });
}
function cell(capacityCkb: bigint, idx: number): Cell {
  return Cell.from({
    outPoint: { txHash: "0x" + "ab".repeat(32), index: idx },
    cellOutput: { capacity: capacityCkb * 100_000_000n, lock: joyidLock() },
    outputData: hexFrom("0x"),
  });
}
function joyidDeps(): CellDep[] {
  return [
    CellDep.from({
      outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 },
      depType: "depGroup",
    }),
  ];
}

function baseInput(): SingleSigSendInput {
  return {
    sourceLock: joyidLock(),
    joyidCellDeps: joyidDeps(),
    recipients: [{ lock: payeeLock(), capacity: 100n * 100_000_000n }],
    availableCells: [cell(200n, 0)],
    feeRateShannonsPerByte: 1200n,
  };
}

describe("buildSingleSigSend", () => {
  it("builds a tx paying the recipient with change back to the source", () => {
    const { tx, change, fee, totalIn } = buildSingleSigSend(baseInput());
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs.length).toBe(2); // recipient + change
    expect(tx.outputs[1].lock.args).toBe(joyidLock().args); // change to source
    expect(totalIn).toBe(200n * 100_000_000n);
    expect(change).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);
  });

  it("uses the JoyID cell deps", () => {
    const { tx } = buildSingleSigSend(baseInput());
    expect(tx.cellDeps.length).toBe(1);
    expect(tx.cellDeps[0].depType).toBe("depGroup");
  });

  it("pre-pads witness[0] for the JoyID lock before fee estimation", () => {
    const { tx } = buildSingleSigSend(baseInput());
    const w0 = tx.witnesses[0];
    // hex string of >= JOYID_WITNESS_PLACEHOLDER_BYTES bytes (2 hex chars/byte + 0x)
    expect(w0.length).toBeGreaterThanOrEqual(2 + JOYID_WITNESS_PLACEHOLDER_BYTES * 2);
  });

  it("rejects a recipient below min cell capacity", () => {
    const input = baseInput();
    const min = minCapacityForLock(payeeLock());
    input.recipients = [{ lock: payeeLock(), capacity: min - 1n }];
    expect(() => buildSingleSigSend(input)).toThrow(/below min capacity/);
  });

  it("throws when balance cannot cover outputs + fee", () => {
    const input = baseInput();
    input.availableCells = [cell(100n, 0)]; // exactly the output, nothing for fee
    expect(() => buildSingleSigSend(input)).toThrow(/insufficient/);
  });
});
