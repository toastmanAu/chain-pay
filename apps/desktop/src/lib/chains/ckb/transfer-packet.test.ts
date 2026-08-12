import { describe, expect, it } from "vitest";
import { Cell, HasherCkb, numToBytes, OutPoint, Script } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";
import { treasuryLockScript } from "./address";
import type { CkbMultisigConfig } from "./multisig";
import {
  buildPaymentSkeleton,
  SECP256K1_BLAKE160_CODE_HASH,
} from "./tx-builder";
import {
  CHAINPAY_TRANSFER_PACKET_VERSION,
  decodeTransferPacket,
  encodeTransferPacket,
  treasurySighashDigest,
} from "./transfer-packet";

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
const payeeScript = Script.from({
  codeHash: SECP256K1_BLAKE160_CODE_HASH,
  hashType: "type",
  args: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const CKB = 100_000_000n;

function makeCell(capacity: bigint, lock: Script, txHashByte = "01", index = 0): Cell {
  return Cell.from({
    outPoint: OutPoint.from({ txHash: "0x" + txHashByte.repeat(32), index }),
    cellOutput: { capacity, lock, type: null },
    outputData: "0x",
  });
}

function buildExampleSkeleton() {
  return buildPaymentSkeleton({
    treasuryConfig: cfg,
    treasuryScript,
    recipients: [{ lock: payeeScript, capacity: 70n * CKB }],
    availableCells: [makeCell(200n * CKB, treasuryScript)],
    network: "testnet",
    feeRateShannonsPerByte: 1000n,
  });
}

describe("treasurySighashDigest", () => {
  it("returns a 32-byte (0x + 64 hex) digest", () => {
    const { tx } = buildExampleSkeleton();
    const digest = treasurySighashDigest(tx);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("matches the manual CKB sighash construction", () => {
    const { tx } = buildExampleSkeleton();
    const digest = treasurySighashDigest(tx);

    // Reference implementation, computed independently.
    const hasher = new HasherCkb();
    hasher.update(tx.hash());
    for (let i = 0; i < tx.inputs.length; i++) {
      const witness = tx.witnesses[i] ?? "0x";
      const raw = hexToBytes(witness);
      hasher.update(numToBytes(raw.length, 8));
      hasher.update(raw);
    }
    expect(digest).toBe(hasher.digest());
  });

  it("changes when any output is changed (sanity)", () => {
    const a = buildExampleSkeleton().tx;
    const b = buildExampleSkeleton().tx;
    // Mutate b's first output capacity by 1 shannon.
    if (b.outputs[0]) b.outputs[0].capacity = 70n * CKB + 1n;
    expect(treasurySighashDigest(a)).not.toBe(treasurySighashDigest(b));
  });
});

describe("encodeTransferPacket / decodeTransferPacket", () => {
  it("round-trips an unsigned packet preserving inputs/outputs/witness/digest", () => {
    const skeleton = buildExampleSkeleton();
    const packet = encodeTransferPacket({
      skeleton,
      treasuryConfig: cfg,
      network: "testnet",
      label: "Test payroll batch",
    });
    const decoded = decodeTransferPacket(packet);

    expect(decoded.version).toBe(CHAINPAY_TRANSFER_PACKET_VERSION);
    expect(decoded.network).toBe("testnet");
    expect(decoded.label).toBe("Test payroll batch");
    expect(decoded.treasuryConfig.m).toBe(cfg.m);
    expect(decoded.treasuryConfig.n).toBe(cfg.n);
    expect(decoded.treasuryConfig.pubkeyHashes).toEqual(cfg.pubkeyHashes);
    expect(decoded.sighashDigest).toBe(treasurySighashDigest(skeleton.tx));
    expect(decoded.tx.inputs.length).toBe(skeleton.tx.inputs.length);
    expect(decoded.tx.outputs.length).toBe(skeleton.tx.outputs.length);
    expect(decoded.tx.witnesses[0]).toBe(skeleton.tx.witnesses[0]);
  });

  it("rejects packets with unknown version", () => {
    const skeleton = buildExampleSkeleton();
    const packet = encodeTransferPacket({
      skeleton,
      treasuryConfig: cfg,
      network: "testnet",
    });
    const tampered = packet.replace(`"version":${CHAINPAY_TRANSFER_PACKET_VERSION}`, '"version":999');
    expect(() => decodeTransferPacket(tampered)).toThrow(/version/i);
  });

  it("rejects packets whose digest doesn't match the embedded tx (corruption detection)", () => {
    const skeleton = buildExampleSkeleton();
    const packet = encodeTransferPacket({
      skeleton,
      treasuryConfig: cfg,
      network: "testnet",
    });
    const realDigest = treasurySighashDigest(skeleton.tx);
    const bogus = "0x" + "00".repeat(32);
    const tampered = packet.replace(realDigest, bogus);
    expect(() => decodeTransferPacket(tampered)).toThrow(/digest|integrity/i);
  });

  it("preserves bigint capacities through JSON round-trip", () => {
    const skeleton = buildExampleSkeleton();
    const packet = encodeTransferPacket({
      skeleton,
      treasuryConfig: cfg,
      network: "testnet",
    });
    const decoded = decodeTransferPacket(packet);
    expect(decoded.tx.outputs[0]?.capacity).toBe(70n * CKB);
  });

  it("emits parseable JSON (no custom binary)", () => {
    const skeleton = buildExampleSkeleton();
    const packet = encodeTransferPacket({
      skeleton,
      treasuryConfig: cfg,
      network: "testnet",
    });
    expect(() => JSON.parse(packet)).not.toThrow();
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
