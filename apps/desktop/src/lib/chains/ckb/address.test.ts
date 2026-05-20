import { describe, expect, it } from "vitest";
import { addressPayloadFromString, AddressFormat } from "@ckb-ccc/core/advanced";
import type { Hex20 } from "@chain-pay/shared";
import type { CkbMultisigConfig } from "./multisig";
import { lockArgsFromConfig } from "./multisig";
import {
  SECP256K1_MULTISIG_V1_CODE_HASH,
  deriveTreasuryAddress,
  treasuryLockScript,
} from "./address";

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

describe("treasuryLockScript", () => {
  it("returns the canonical secp256k1_blake160_multisig_all V1 script with our lock args", () => {
    const script = treasuryLockScript(cfg2of3);
    expect(script.codeHash).toBe(SECP256K1_MULTISIG_V1_CODE_HASH);
    expect(script.hashType).toBe("type");
    expect(script.args).toBe(bytesToHex(lockArgsFromConfig(cfg2of3)));
  });

  it("appends the 8-byte since to args when time-locked", () => {
    const since = 0x4000000000000064n;
    const script = treasuryLockScript({ ...cfg2of3, since });
    expect(script.args.length).toBe(2 + 28 * 2); // "0x" + 28 bytes hex
  });
});

describe("deriveTreasuryAddress", () => {
  it("emits a ckt-prefixed bech32m address on testnet", () => {
    const addr = deriveTreasuryAddress(cfg2of3, "testnet");
    expect(addr).toMatch(/^ckt1/);
  });

  it("emits a ckb-prefixed bech32m address on mainnet", () => {
    const addr = deriveTreasuryAddress(cfg2of3, "mainnet");
    expect(addr).toMatch(/^ckb1/);
  });

  it("encodes the V1 multisig script in Full payload (round-trip via CCC decoder)", () => {
    const addr = deriveTreasuryAddress(cfg2of3, "testnet");
    const { prefix, format, payload } = addressPayloadFromString(addr);
    expect(prefix).toBe("ckt");
    expect(format).toBe(AddressFormat.Full);

    // payload = codeHash(32) | hashType(1) | args(20 or 28)
    const codeHashBytes = payload.slice(0, 32);
    const hashTypeByte = payload[32];
    const argsBytes = payload.slice(33);

    expect(bytesToHex(new Uint8Array(codeHashBytes))).toBe(SECP256K1_MULTISIG_V1_CODE_HASH);
    expect(hashTypeByte).toBe(1); // "type" === 1
    expect(bytesToHex(new Uint8Array(argsBytes))).toBe(bytesToHex(lockArgsFromConfig(cfg2of3)));
  });

  it("produces different addresses for different M-of-N configs (sanity)", () => {
    const a = deriveTreasuryAddress(cfg2of3, "testnet");
    const b = deriveTreasuryAddress({ ...cfg2of3, m: 3 }, "testnet");
    expect(a).not.toBe(b);
  });

  it("produces different addresses across networks even for identical configs", () => {
    const mainnet = deriveTreasuryAddress(cfg2of3, "mainnet");
    const testnet = deriveTreasuryAddress(cfg2of3, "testnet");
    expect(mainnet.startsWith("ckb1")).toBe(true);
    expect(testnet.startsWith("ckt1")).toBe(true);
    expect(mainnet.slice(4)).not.toBe(testnet.slice(4)); // bech32m checksum differs by HRP
  });

  it("encodes a time-locked config with 28-byte args", () => {
    const addr = deriveTreasuryAddress({ ...cfg2of3, since: 0x4000000000000064n }, "testnet");
    const { payload } = addressPayloadFromString(addr);
    const argsBytes = payload.slice(33);
    expect(argsBytes.length).toBe(28);
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
