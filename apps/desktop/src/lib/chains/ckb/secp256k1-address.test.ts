import { describe, it, expect } from "vitest";
import { ScriptInfo } from "@ckb-ccc/core";
import { addressPayloadFromString, AddressFormat } from "@ckb-ccc/core/advanced";
import { secp256k1AddressFromLockArgs } from "./secp256k1-address";

/** Real secp256k1_blake160_sighash_all code hash (same on mainnet and testnet). */
const SECP256K1_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
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

function bytesToHex(bytes: ArrayLike<number>): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("secp256k1AddressFromLockArgs", () => {
  it("produces a ckt1-prefixed address for testnet", () => {
    const addr = secp256k1AddressFromLockArgs(ARGS, "ckt", fakeScriptInfo());
    expect(addr).toMatch(/^ckt1/);
  });

  it("produces a ckb1-prefixed address for mainnet", () => {
    const addr = secp256k1AddressFromLockArgs(ARGS, "ckb", fakeScriptInfo());
    expect(addr).toMatch(/^ckb1/);
  });

  it("round-trips: decoding yields the original args and sighash-all codeHash", () => {
    const addr = secp256k1AddressFromLockArgs(ARGS, "ckt", fakeScriptInfo());
    const { prefix, format, payload } = addressPayloadFromString(addr);

    expect(prefix).toBe("ckt");
    expect(format).toBe(AddressFormat.Full);

    // Full-format payload: codeHash(32 bytes) | hashType(1 byte) | args(N bytes)
    const codeHashHex = bytesToHex(payload.slice(0, 32));
    const hashTypeByte = payload[32];
    const argsHex = bytesToHex(payload.slice(33));

    expect(codeHashHex).toBe(SECP256K1_CODE_HASH);
    expect(hashTypeByte).toBe(1); // "type" = 1
    expect(argsHex).toBe(ARGS);
  });

  it("produces distinct addresses for distinct args", () => {
    const a = secp256k1AddressFromLockArgs(ARGS, "ckt", fakeScriptInfo());
    const b = secp256k1AddressFromLockArgs("0x" + "cd".repeat(20), "ckt", fakeScriptInfo());
    expect(a).not.toBe(b);
  });

  it("produces distinct addresses across networks for identical args", () => {
    const mainnet = secp256k1AddressFromLockArgs(ARGS, "ckb", fakeScriptInfo());
    const testnet = secp256k1AddressFromLockArgs(ARGS, "ckt", fakeScriptInfo());
    expect(mainnet).not.toBe(testnet);
    expect(mainnet).toMatch(/^ckb1/);
    expect(testnet).toMatch(/^ckt1/);
  });
});
