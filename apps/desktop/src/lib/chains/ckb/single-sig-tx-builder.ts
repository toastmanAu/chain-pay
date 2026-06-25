import {
  Cell,
  CellDep,
  CellInput,
  CellOutput,
  hexFrom,
  Script,
  Transaction,
} from "@ckb-ccc/core";
import { minCapacityForLock } from "./tx-builder";

const SHANNONS_PER_BYTE = 100_000_000n;
const TX_SIZE_OVERHEAD_BYTES = 4n;

/**
 * JoyID's real witness lock (WebAuthn authenticatorData + clientDataJSON + sig)
 * is larger than a bare secp witness. Pre-pad witness[0] so fee estimation
 * accounts for it; JoyID overwrites this slot at sign time. 1000 bytes covers a
 * plain transfer per ~/.claude/rules/ckb-transactions.md (mints need more, but
 * single-sig SMB sends are plain transfers).
 */
export const JOYID_WITNESS_PLACEHOLDER_BYTES = 1000;

export interface SingleSigRecipient {
  lock: Script;
  capacity: bigint;
}

export interface SingleSigSendInput {
  sourceLock: Script;
  joyidCellDeps: CellDep[];
  recipients: SingleSigRecipient[];
  availableCells: Cell[];
  feeRateShannonsPerByte: bigint;
}

export interface SingleSigSendSkeleton {
  tx: Transaction;
  totalIn: bigint;
  totalOut: bigint;
  change: bigint;
  fee: bigint;
}

export function buildSingleSigSend(input: SingleSigSendInput): SingleSigSendSkeleton {
  validate(input);

  const tx = Transaction.from({
    version: 0n,
    cellDeps: input.joyidCellDeps,
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  for (const r of input.recipients) {
    tx.outputs.push(CellOutput.from({ capacity: r.capacity, lock: r.lock }));
    tx.outputsData.push(hexFrom("0x"));
  }
  const totalOut = input.recipients.reduce((s, r) => s + r.capacity, 0n);

  // JoyID witness placeholder before fee estimation (zeros; JoyID fills it).
  tx.setWitnessAt(0, hexFrom(new Uint8Array(JOYID_WITNESS_PLACEHOLDER_BYTES)));

  const { selected, totalIn } = selectInputs(input.availableCells, totalOut);
  for (const c of selected) {
    tx.inputs.push(CellInput.from({ previousOutput: c.outPoint, since: 0n }));
  }
  while (tx.witnesses.length < tx.inputs.length) tx.witnesses.push(hexFrom("0x"));

  const minChange = minCapacityForLock(input.sourceLock);
  tx.outputs.push(CellOutput.from({ capacity: 0n, lock: input.sourceLock }));
  tx.outputsData.push(hexFrom("0x"));

  const feeWithChange = serialisedSize(tx) * input.feeRateShannonsPerByte;
  const remainder = totalIn - totalOut - feeWithChange;
  if (remainder < 0n) {
    throw new Error(`insufficient capacity: have ${totalIn}, need ${totalOut + feeWithChange}`);
  }
  if (remainder >= minChange) {
    tx.outputs[tx.outputs.length - 1].capacity = remainder;
    return { tx, totalIn, totalOut: totalOut + remainder, change: remainder, fee: feeWithChange };
  }

  // Change can't survive — drop it, donate remainder to fee.
  tx.outputs.pop();
  tx.outputsData.pop();
  const fee = totalIn - totalOut;
  const minFee = serialisedSize(tx) * input.feeRateShannonsPerByte;
  if (fee < minFee) {
    throw new Error(`insufficient capacity after dropping change: fee ${fee} < required ${minFee}`);
  }
  return { tx, totalIn, totalOut, change: 0n, fee };
}

function validate(input: SingleSigSendInput): void {
  if (input.recipients.length === 0) throw new Error("at least one recipient is required");
  for (const [i, r] of input.recipients.entries()) {
    const min = minCapacityForLock(r.lock);
    if (r.capacity < min) {
      throw new Error(`recipient[${i}] capacity ${r.capacity} is below min capacity ${min}`);
    }
  }
  if (input.feeRateShannonsPerByte <= 0n) throw new Error("feeRateShannonsPerByte must be > 0");
}

function selectInputs(cells: Cell[], needed: bigint): { selected: Cell[]; totalIn: bigint } {
  const sorted = [...cells].sort((a, b) => {
    const d = b.cellOutput.capacity - a.cellOutput.capacity;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const selected: Cell[] = [];
  let totalIn = 0n;
  for (const c of sorted) {
    selected.push(c);
    totalIn += c.cellOutput.capacity;
    if (totalIn >= needed) break;
  }
  if (totalIn < needed) {
    throw new Error(`insufficient capacity: have ${totalIn}, need at least ${needed} (before fee)`);
  }
  return { selected, totalIn };
}

function serialisedSize(tx: Transaction): bigint {
  return BigInt(tx.toBytes().length) + TX_SIZE_OVERHEAD_BYTES;
}
