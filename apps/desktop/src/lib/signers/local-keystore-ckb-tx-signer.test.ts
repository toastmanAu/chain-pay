import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import type { Hex20 } from "@shared/types";
import { LocalKeystoreCkbTxSigner } from "./local-keystore-ckb-tx-signer";

const LOCK_ARGS = ("0x" + "ab".repeat(20)) as Hex20;
const SIG_HEX = ("0x" + "ff".repeat(65)) as `0x${string}`;

function makeTx(): Transaction {
  return Transaction.from({
    inputs: [{ previousOutput: { txHash: "0x" + "22".repeat(32), index: 0 } }],
    outputs: [],
    outputsData: [],
  });
}

/** A fake bridge whose signTx is a typed mock. */
function makeBridge(returnValue?: { signedTx: string }) {
  type SignTxFn = (req: unknown) => Promise<{ signedTx: string }>;
  const signTx = vi.fn<SignTxFn>();
  if (returnValue !== undefined) {
    signTx.mockResolvedValue(returnValue);
  }
  return { signTx };
}

function makeSigner(bridge: ReturnType<typeof makeBridge>) {
  return new LocalKeystoreCkbTxSigner({
    keyvaultId: "main",
    derivationIndex: 0,
    sourceLockArgs: LOCK_ARGS,
    password: "pw",
    bridge,
  });
}

describe("LocalKeystoreCkbTxSigner", () => {
  it("sends the right keyvaultId, derivationIndex, password, sourceLockArgs and groupInputIndices to the bridge", async () => {
    const tx = makeTx();
    const bridge = makeBridge({ signedTx: tx.stringify() });
    const signer = makeSigner(bridge);

    await signer.signTransaction(tx);

    expect(bridge.signTx).toHaveBeenCalledOnce();
    expect(bridge.signTx).toHaveBeenCalledWith(
      expect.objectContaining({
        keyvaultId: "main",
        derivationIndex: 0,
        password: "pw",
        sourceLockArgs: LOCK_ARGS,
        groupInputIndices: [0],
      }),
    );
  });

  it("returns the rebuilt Transaction from the bridge response", async () => {
    const tx = makeTx();
    // Simulate main attaching a signature into witness[0]
    const withSig = Transaction.from(
      JSON.parse(tx.stringify()) as Parameters<typeof Transaction.from>[0],
    );
    withSig.witnesses[0] = SIG_HEX;
    const bridge = makeBridge({ signedTx: withSig.stringify() });
    const signer = makeSigner(bridge);

    const result = await signer.signTransaction(tx);

    expect(result).toBeInstanceOf(Transaction);
    expect(result.witnesses[0]).toBe(SIG_HEX);
  });

  it("connect returns the source lockArgs with an empty address (no interactive step)", async () => {
    const bridge = makeBridge();
    const signer = makeSigner(bridge);

    const result = await signer.connect();

    expect(result.lockArgs).toBe(LOCK_ARGS);
    expect(result.address).toBe("");
  });

  it("ignores the optional preview param (no phone to display on)", async () => {
    const tx = makeTx();
    const bridge = makeBridge({ signedTx: tx.stringify() });
    const signer = makeSigner(bridge);

    // preview is part of CkbTxSigner contract for the JoyID phone flow;
    // local signer silently ignores it
    await expect(
      signer.signTransaction(tx, { to: [{ address: "ckt1qdest", ckb: "100" }], feeCkb: "0.001" }),
    ).resolves.not.toThrow();
  });

  it("has kind 'local-keystore'", () => {
    const signer = makeSigner(makeBridge());
    expect(signer.kind).toBe("local-keystore");
  });
});
