import {
  bytesFrom,
  hexFrom,
  HasherCkb,
  type Hex,
  numToBytes,
  Transaction,
} from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";
import type { CkbMultisigConfig } from "./multisig";
import type { CkbNetwork } from "../../light-client/network-configs";
import type { PaymentSkeleton } from "./tx-builder";

export const CHAINPAY_TRANSFER_PACKET_VERSION = 1 as const;

/**
 * Compute the CKB sighash digest for a treasury-owned tx skeleton.
 *
 * Layout per CKB convention (the digest each multisig co-signer must produce
 * a 65-byte ECDSA-recoverable signature over):
 *
 *   blake2b_ckb(
 *     tx_hash(32)
 *       || u64_le(len(witness[0])) || witness[0]
 *       || u64_le(len(witness[1])) || witness[1]
 *       || ...
 *       || u64_le(len(witness[N-1])) || witness[N-1]
 *   )
 *
 * Assumes ALL inputs belong to the same treasury script group (i.e. ChainPay
 * payments fund only from a single treasury at a time). When we add
 * cross-treasury batched payments (Phase 2.5+), this needs the same loop but
 * filtered to inputs whose lock matches the treasury script.
 *
 * witness[0] MUST already contain the placeholderWitnessLock for this treasury
 * (multisig_script + M × 65 zero bytes) — verified by `buildPaymentSkeleton`.
 */
export function treasurySighashDigest(tx: Transaction): Hex {
  const hasher = new HasherCkb();
  hasher.update(tx.hash());
  for (let i = 0; i < tx.inputs.length; i++) {
    const witness = tx.witnesses[i] ?? hexFrom("0x");
    const raw = bytesFrom(witness);
    hasher.update(numToBytes(raw.length, 8));
    hasher.update(raw);
  }
  return hasher.digest();
}

export interface EncodeTransferPacketInput {
  skeleton: PaymentSkeleton;
  treasuryConfig: CkbMultisigConfig;
  network: CkbNetwork;
  /** Human-readable purpose ("March payroll batch"). Optional. */
  label?: string;
}

interface PacketTxInput {
  previousOutput: { txHash: string; index: string };
  since: string;
}

interface PacketCellOutput {
  capacity: string; // bigint as hex
  lock: { codeHash: string; hashType: string; args: string };
  type: { codeHash: string; hashType: string; args: string } | null;
}

interface PacketWireFormat {
  version: typeof CHAINPAY_TRANSFER_PACKET_VERSION;
  network: CkbNetwork;
  label: string | null;
  treasuryConfig: {
    s: 0;
    r: number;
    m: number;
    n: number;
    pubkeyHashes: Hex20[];
    since: string | null;
  };
  sighashDigest: string;
  tx: {
    version: string;
    cellDeps: Array<{
      outPoint: { txHash: string; index: string };
      depType: string;
    }>;
    headerDeps: string[];
    inputs: PacketTxInput[];
    outputs: PacketCellOutput[];
    outputsData: string[];
    witnesses: string[];
  };
  meta: {
    totalIn: string;
    totalOut: string;
    change: string;
    fee: string;
  };
}

export interface DecodedTransferPacket {
  version: typeof CHAINPAY_TRANSFER_PACKET_VERSION;
  network: CkbNetwork;
  label: string | null;
  treasuryConfig: CkbMultisigConfig;
  sighashDigest: Hex;
  tx: Transaction;
  meta: { totalIn: bigint; totalOut: bigint; change: bigint; fee: bigint };
}

export function encodeTransferPacket(input: EncodeTransferPacketInput): string {
  const { skeleton, treasuryConfig, network, label } = input;
  const sighashDigest = treasurySighashDigest(skeleton.tx);

  const packet: PacketWireFormat = {
    version: CHAINPAY_TRANSFER_PACKET_VERSION,
    network,
    label: label ?? null,
    treasuryConfig: {
      s: 0,
      r: treasuryConfig.r,
      m: treasuryConfig.m,
      n: treasuryConfig.n,
      pubkeyHashes: treasuryConfig.pubkeyHashes,
      since: treasuryConfig.since !== undefined ? bigintHex(treasuryConfig.since) : null,
    },
    sighashDigest,
    tx: {
      version: bigintHex(skeleton.tx.version),
      cellDeps: skeleton.tx.cellDeps.map((d) => ({
        outPoint: {
          txHash: d.outPoint.txHash,
          index: bigintHex(d.outPoint.index),
        },
        depType: d.depType,
      })),
      headerDeps: skeleton.tx.headerDeps,
      inputs: skeleton.tx.inputs.map((i) => ({
        previousOutput: {
          txHash: i.previousOutput.txHash,
          index: bigintHex(i.previousOutput.index),
        },
        since: bigintHex(i.since),
      })),
      outputs: skeleton.tx.outputs.map((o) => ({
        capacity: bigintHex(o.capacity),
        lock: { codeHash: o.lock.codeHash, hashType: o.lock.hashType, args: o.lock.args },
        type: o.type
          ? { codeHash: o.type.codeHash, hashType: o.type.hashType, args: o.type.args }
          : null,
      })),
      outputsData: skeleton.tx.outputsData,
      witnesses: skeleton.tx.witnesses,
    },
    meta: {
      totalIn: bigintHex(skeleton.totalIn),
      totalOut: bigintHex(skeleton.totalOut),
      change: bigintHex(skeleton.change),
      fee: bigintHex(skeleton.fee),
    },
  };
  return JSON.stringify(packet);
}

export function decodeTransferPacket(json: string): DecodedTransferPacket {
  const parsed = JSON.parse(json) as PacketWireFormat;

  if (parsed.version !== CHAINPAY_TRANSFER_PACKET_VERSION) {
    throw new Error(
      `unsupported transfer-packet version ${parsed.version} (expected ${CHAINPAY_TRANSFER_PACKET_VERSION})`,
    );
  }

  const tx = Transaction.from({
    version: BigInt(parsed.tx.version),
    cellDeps: parsed.tx.cellDeps.map((d) => ({
      outPoint: { txHash: d.outPoint.txHash, index: BigInt(d.outPoint.index) },
      depType: d.depType as "depGroup" | "code",
    })),
    headerDeps: parsed.tx.headerDeps,
    inputs: parsed.tx.inputs.map((i) => ({
      previousOutput: {
        txHash: i.previousOutput.txHash,
        index: BigInt(i.previousOutput.index),
      },
      since: BigInt(i.since),
    })),
    outputs: parsed.tx.outputs.map((o) => ({
      capacity: BigInt(o.capacity),
      lock: o.lock,
      type: o.type,
    })),
    outputsData: parsed.tx.outputsData,
    witnesses: parsed.tx.witnesses,
  });

  const recomputed = treasurySighashDigest(tx);
  if (recomputed !== parsed.sighashDigest) {
    throw new Error(
      `transfer-packet integrity check failed: embedded digest ${parsed.sighashDigest} but recomputed ${recomputed}`,
    );
  }

  const treasuryConfig: CkbMultisigConfig = {
    s: 0,
    r: parsed.treasuryConfig.r,
    m: parsed.treasuryConfig.m,
    n: parsed.treasuryConfig.n,
    pubkeyHashes: parsed.treasuryConfig.pubkeyHashes,
    ...(parsed.treasuryConfig.since !== null
      ? { since: BigInt(parsed.treasuryConfig.since) }
      : {}),
  };

  return {
    version: parsed.version,
    network: parsed.network,
    label: parsed.label,
    treasuryConfig,
    sighashDigest: parsed.sighashDigest as Hex,
    tx,
    meta: {
      totalIn: BigInt(parsed.meta.totalIn),
      totalOut: BigInt(parsed.meta.totalOut),
      change: BigInt(parsed.meta.change),
      fee: BigInt(parsed.meta.fee),
    },
  };
}

function bigintHex(value: bigint | number): string {
  return "0x" + BigInt(value).toString(16);
}
