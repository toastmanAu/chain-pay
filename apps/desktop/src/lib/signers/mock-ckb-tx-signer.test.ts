import { describe, it, expect } from "vitest";
import { Transaction, CellOutput, Script, hexFrom } from "@ckb-ccc/core";
import { MockCkbTxSigner } from "./mock-ckb-tx-signer";

function unsignedTx(): Transaction {
  const tx = Transaction.from({
    version: 0n, cellDeps: [], headerDeps: [], inputs: [], outputs: [], outputsData: [], witnesses: [],
  });
  tx.outputs.push(CellOutput.from({
    capacity: 100n * 100_000_000n,
    lock: Script.from({ codeHash: "0x" + "00".repeat(32), hashType: "type", args: "0x" }),
  }));
  tx.outputsData.push(hexFrom("0x"));
  tx.setWitnessAt(0, hexFrom(new Uint8Array(1000)));
  return tx;
}

describe("MockCkbTxSigner", () => {
  it("connects to a deterministic address", async () => {
    const signer = new MockCkbTxSigner();
    const { address, lockArgs } = await signer.connect();
    expect(address).toBe("ckt1qmocksource");
    expect(lockArgs).toBe("0x" + "11".repeat(20));
  });

  it("replaces the empty witness[0] placeholder with a non-zero signed marker", async () => {
    const signer = new MockCkbTxSigner();
    const signed = await signer.signTransaction(unsignedTx());
    const w0 = signed.witnesses[0];
    expect(w0).toBeDefined();
    expect(w0!).not.toBe(hexFrom(new Uint8Array(1000)));
    expect(w0!.length).toBeGreaterThan(2);
  });
});
