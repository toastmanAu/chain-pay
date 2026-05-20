import {
  Cell,
  CellDep,
  CellInput,
  CellOutput,
  hexFrom,
  numFrom,
  Script,
  Transaction,
  WitnessArgs,
} from "@ckb-ccc/core";
import type { CkbMultisigConfig } from "./multisig";
import { placeholderWitnessLock } from "./multisig";
import type { CkbNetwork } from "../../light-client/network-configs";

const SHANNONS_PER_BYTE = 100_000_000n;
const TX_SIZE_OVERHEAD_BYTES = 4n; // miner-side serialised-size accounting

/** Canonical `secp256k1_blake160_sighash_all` (single-sig) — for payee outputs etc. */
export const SECP256K1_BLAKE160_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8" as const;

const V1_MULTISIG_CELL_DEPS: Record<CkbNetwork, { txHash: string; index: number }> = {
  mainnet: {
    txHash: "0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c",
    index: 1,
  },
  testnet: {
    txHash: "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
    index: 1,
  },
};

export function treasuryCellDep(network: CkbNetwork): CellDep {
  const { txHash, index } = V1_MULTISIG_CELL_DEPS[network];
  return CellDep.from({
    outPoint: { txHash, index: numFrom(index) },
    depType: "depGroup",
  });
}

export function minCapacityForLock(lock: Script): bigint {
  // CellOutput.occupiedSize = 8 (capacity) + lock.occupiedSize + (type?.occupiedSize ?? 0)
  // For an output with no type and no data, that's the full footprint.
  const cellOutput = CellOutput.from({ capacity: 0n, lock });
  return BigInt(cellOutput.occupiedSize) * SHANNONS_PER_BYTE;
}

export interface PaymentRecipient {
  lock: Script;
  capacity: bigint;
}

export interface PaymentSkeletonInput {
  treasuryConfig: CkbMultisigConfig;
  treasuryScript: Script;
  recipients: PaymentRecipient[];
  availableCells: Cell[];
  network: CkbNetwork;
  feeRateShannonsPerByte: bigint;
}

export interface PaymentSkeleton {
  tx: Transaction;
  totalIn: bigint;
  totalOut: bigint;
  change: bigint;
  fee: bigint;
}

/**
 * Build an unsigned CKB transaction paying `recipients` from `treasuryScript`'s
 * UTXO set. Pure function — caller supplies the candidate `availableCells` list
 * (typically from the embedded light client).
 *
 * Pre-pads witness[0] with `placeholderWitnessLock(treasuryConfig)` before fee
 * estimation so signers can drop their real sigs into the existing slots
 * without changing the tx size. This is mandatory per
 * `~/.claude/rules/ckb-transactions.md` — completeFeeBy in CCC's clone path
 * has been observed to drop caller-side witness padding.
 */
export function buildPaymentSkeleton(input: PaymentSkeletonInput): PaymentSkeleton {
  validateInput(input);

  const tx = Transaction.from({
    version: 0n,
    cellDeps: [treasuryCellDep(input.network)],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const recipientOutputs = input.recipients.map((r) => buildRecipientOutput(r));
  for (const output of recipientOutputs) {
    tx.outputs.push(output);
    tx.outputsData.push(hexFrom("0x"));
  }
  const totalOutCapacity = recipientOutputs.reduce((s, o) => s + o.capacity, 0n);

  primeWitness(tx, input.treasuryConfig);

  const { selected, totalIn } = selectInputs(input.availableCells, totalOutCapacity);
  for (const cell of selected) {
    tx.inputs.push(
      CellInput.from({
        previousOutput: cell.outPoint,
        since: 0n,
      }),
    );
  }

  // Try with change first, then drop if change < minCapacity.
  const minChange = minCapacityForLock(input.treasuryScript);
  appendChangeOutput(tx, input.treasuryScript, 0n); // placeholder so size is right
  const sizeWithChange = txSerialisedSize(tx);
  const feeWithChange = sizeWithChange * input.feeRateShannonsPerByte;

  const remainder = totalIn - totalOutCapacity - feeWithChange;
  if (remainder < 0n) {
    throw new Error(
      `insufficient treasury capacity: have ${totalIn}, need ${totalOutCapacity + feeWithChange} (outputs + fee)`,
    );
  }

  if (remainder >= minChange) {
    setChangeCapacity(tx, remainder);
    return { tx, totalIn, totalOut: totalOutCapacity + remainder, change: remainder, fee: feeWithChange };
  }

  // Change can't survive — drop it and donate the remainder to the fee.
  tx.outputs.pop();
  tx.outputsData.pop();
  const sizeNoChange = txSerialisedSize(tx);
  const fee = totalIn - totalOutCapacity;
  // Sanity: even without change, fee must cover the no-change size at the requested rate.
  const minFeeNoChange = sizeNoChange * input.feeRateShannonsPerByte;
  if (fee < minFeeNoChange) {
    throw new Error(
      `insufficient capacity after dropping change: fee ${fee} < required ${minFeeNoChange}`,
    );
  }
  return { tx, totalIn, totalOut: totalOutCapacity, change: 0n, fee };
}

function validateInput(input: PaymentSkeletonInput): void {
  if (input.recipients.length === 0) {
    throw new Error("at least one recipient is required");
  }
  for (const [i, r] of input.recipients.entries()) {
    const min = minCapacityForLock(r.lock);
    if (r.capacity < min) {
      throw new Error(
        `recipient[${i}] capacity ${r.capacity} is below min capacity ${min} for its lock`,
      );
    }
  }
  if (input.feeRateShannonsPerByte <= 0n) {
    throw new Error("feeRateShannonsPerByte must be > 0");
  }
}

function buildRecipientOutput(r: PaymentRecipient): CellOutput {
  return CellOutput.from({ capacity: r.capacity, lock: r.lock });
}

function primeWitness(tx: Transaction, cfg: CkbMultisigConfig): void {
  const lockBytes = placeholderWitnessLock(cfg);
  const witness = WitnessArgs.from({ lock: hexFrom(lockBytes) });
  // setWitnessAt grows the witnesses array as needed.
  tx.setWitnessAt(0, hexFrom(witness.toBytes()));
}

function selectInputs(
  cells: Cell[],
  neededOutCapacity: bigint,
): { selected: Cell[]; totalIn: bigint } {
  // Greedy largest-first to minimise input count → smaller tx → smaller fee.
  const sorted = [...cells].sort((a, b) => {
    const diff = b.cellOutput.capacity - a.cellOutput.capacity;
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  const selected: Cell[] = [];
  let totalIn = 0n;
  for (const cell of sorted) {
    selected.push(cell);
    totalIn += cell.cellOutput.capacity;
    // Stop when we have at least the requested outputs covered; the fee will
    // be checked after change handling.
    if (totalIn >= neededOutCapacity) break;
  }
  if (totalIn < neededOutCapacity) {
    throw new Error(
      `insufficient treasury capacity: have ${totalIn}, need at least ${neededOutCapacity} (before fee)`,
    );
  }
  return { selected, totalIn };
}

function appendChangeOutput(tx: Transaction, treasuryScript: Script, capacity: bigint): void {
  tx.outputs.push(CellOutput.from({ capacity, lock: treasuryScript }));
  tx.outputsData.push(hexFrom("0x"));
}

function setChangeCapacity(tx: Transaction, capacity: bigint): void {
  const last = tx.outputs[tx.outputs.length - 1];
  if (last) last.capacity = capacity;
}

function txSerialisedSize(tx: Transaction): bigint {
  return BigInt(tx.toBytes().length) + TX_SIZE_OVERHEAD_BYTES;
}
