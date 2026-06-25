import { Transaction, hexFrom } from "@ckb-ccc/core";
import type { TransactionLike } from "@ckb-ccc/core";
import type { CkbTxSigner } from "./ckb-tx-signer";

/** Deterministic test signer — no popup, no key. */
export class MockCkbTxSigner implements CkbTxSigner {
  readonly kind = "joyid" as const;

  async connect(): Promise<{ address: string; lockArgs: string }> {
    return { address: "ckt1qmocksource", lockArgs: "0x" + "11".repeat(20) };
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    const signed = Transaction.from({
      version: unsigned.version,
      cellDeps: unsigned.cellDeps,
      headerDeps: unsigned.headerDeps,
      inputs: unsigned.inputs,
      outputs: unsigned.outputs,
      outputsData: unsigned.outputsData,
      witnesses: [...unsigned.witnesses],
    } as unknown as TransactionLike);
    // Stand-in for JoyID's filled lock: a fixed non-zero 1000-byte witness.
    signed.setWitnessAt(0, hexFrom(new Uint8Array(1000).fill(7)));
    return signed;
  }
}
