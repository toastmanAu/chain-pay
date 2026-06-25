import { describe, it, expect } from "vitest";
import { CellDep, ScriptInfo } from "@ckb-ccc/core";
import { joyidLockAndDeps } from "./joyid-lock";

const JOYID_CODE_HASH = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const ARGS = "0x0001f293e5a5d1f8e8b7c6a5b4c3d2e1f0011223";

function fakeScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: JOYID_CODE_HASH,
    hashType: "type",
    cellDeps: [
      {
        cellDep: {
          outPoint: {
            txHash: "0x4dcf3f3b09efac8995d6cbee87c5345e812d310094651e0c3d9a730f32dc9263",
            index: 0,
          },
          depType: "depGroup",
        },
      },
    ],
  });
}

describe("joyidLockAndDeps", () => {
  it("builds the JoyID lock script from scriptInfo + args", () => {
    const { lock } = joyidLockAndDeps(fakeScriptInfo(), ARGS);
    expect(lock.codeHash).toBe(JOYID_CODE_HASH);
    expect(lock.hashType).toBe("type");
    expect(lock.args).toBe(ARGS);
  });

  it("extracts the JoyID cell deps", () => {
    const { cellDeps } = joyidLockAndDeps(fakeScriptInfo(), ARGS);
    expect(cellDeps).toHaveLength(1);
    const dep0 = cellDeps[0];
    expect(dep0).toBeDefined();
    expect(dep0!).toBeInstanceOf(CellDep);
    expect(dep0!.depType).toBe("depGroup");
  });
});
