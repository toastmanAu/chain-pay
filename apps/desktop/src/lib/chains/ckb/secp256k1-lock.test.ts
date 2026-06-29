import { describe, it, expect } from "vitest";
import { CellDep, ScriptInfo } from "@ckb-ccc/core";
import { secp256k1LockAndDeps } from "./secp256k1-lock";

const SECP256K1_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const ARGS = "0x" + "ab".repeat(20);

function fakeScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: SECP256K1_CODE_HASH,
    hashType: "type",
    cellDeps: [
      {
        cellDep: {
          outPoint: {
            txHash: "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
            index: 0,
          },
          depType: "depGroup",
        },
      },
    ],
  });
}

describe("secp256k1LockAndDeps", () => {
  it("builds a sighash-all lock with the given args", () => {
    const { lock } = secp256k1LockAndDeps(fakeScriptInfo(), ARGS);
    expect(lock.codeHash).toBe(SECP256K1_CODE_HASH);
    expect(lock.hashType).toBe("type");
    expect(lock.args).toBe(ARGS);
  });

  it("extracts the secp256k1 cell deps", () => {
    const { cellDeps } = secp256k1LockAndDeps(fakeScriptInfo(), ARGS);
    expect(cellDeps).toHaveLength(1);
    const dep0 = cellDeps[0];
    expect(dep0).toBeDefined();
    expect(dep0!).toBeInstanceOf(CellDep);
    expect(dep0!.depType).toBe("depGroup");
  });
});
