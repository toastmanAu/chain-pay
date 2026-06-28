import { describe, it, expect } from "vitest";
import { ScriptInfo } from "@ckb-ccc/core";
import { buildKeystoreSource } from "./keystore-source";
import { secp256k1AddressFromLockArgs } from "@/lib/chains/ckb/secp256k1-address";

const SECP256K1_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const LOCK_ARGS = "0x" + "ab".repeat(20);

function fakeScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: SECP256K1_CODE_HASH,
    hashType: "type",
    cellDeps: [
      {
        cellDep: {
          outPoint: {
            txHash:
              "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
            index: 0,
          },
          depType: "depGroup",
        },
      },
    ],
  });
}

describe("buildKeystoreSource", () => {
  it("builds a secp256k1 Source carrying the keystore identity", () => {
    const { source } = buildKeystoreSource(LOCK_ARGS, "testnet", fakeScriptInfo());
    expect(source.lockKind).toBe("secp256k1");
    expect(source.keyvaultId).toBe("main");
    expect(source.derivationIndex).toBe(0);
    // The lock-args ride in the historically-named field used for watch + change.
    expect(source.joyidLockArgs).toBe(LOCK_ARGS);
    expect(typeof source.id).toBe("string");
    expect(source.id.length).toBeGreaterThan(0);
    expect(source.createdAt).toBe(source.updatedAt);
  });

  it("derives the address that matches the secp256k1 lock encoder (testnet)", () => {
    const { source } = buildKeystoreSource(LOCK_ARGS, "testnet", fakeScriptInfo());
    expect(source.chain).toBe("ckb:testnet");
    expect(source.address).toBe(
      secp256k1AddressFromLockArgs(LOCK_ARGS, "ckt", fakeScriptInfo()),
    );
    expect(source.address).toMatch(/^ckt1/);
  });

  it("derives a mainnet address + chain for mainnet", () => {
    const { source } = buildKeystoreSource(LOCK_ARGS, "mainnet", fakeScriptInfo());
    expect(source.chain).toBe("ckb:mainnet");
    expect(source.address).toBe(
      secp256k1AddressFromLockArgs(LOCK_ARGS, "ckb", fakeScriptInfo()),
    );
    expect(source.address).toMatch(/^ckb1/);
  });

  it("returns the lock to watch — same codeHash + args as the source", () => {
    const { lock } = buildKeystoreSource(LOCK_ARGS, "testnet", fakeScriptInfo());
    expect(lock.codeHash).toBe(SECP256K1_CODE_HASH);
    expect(lock.args).toBe(LOCK_ARGS);
  });
});
