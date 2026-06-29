import { describe, it, expect } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import { computeSighashAllDigest } from "./ckb-sighash";
import {
  signDigest,
  recoverPubkeyHashFromSignature,
  pubkeyHashFromPrivateKey,
} from "../../../apps/desktop/src/lib/signers/ckb-secp256k1";

describe("computeSighashAllDigest", () => {
  it("digest signs and recovers to the signing key", () => {
    const priv = "0x" + "11".repeat(32);
    const tx = Transaction.from({
      inputs: [{ previousOutput: { txHash: "0x" + "22".repeat(32), index: 0 } }],
      outputs: [
        {
          capacity: 6100000000n,
          lock: {
            codeHash: "0x" + "33".repeat(32),
            hashType: "type",
            args: "0x",
          },
        },
      ],
      outputsData: ["0x"],
    });
    // Witness slot is empty — the helper inserts the 65-byte zeroed lock placeholder
    tx.witnesses[0] = "0x";

    const digest = computeSighashAllDigest(tx, [0]);

    // Digest must be a 0x-prefixed 32-byte hex string
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);

    const sig = signDigest(digest, priv);
    const recovered = recoverPubkeyHashFromSignature(digest, sig);
    const expected = pubkeyHashFromPrivateKey(priv);

    expect(recovered).toBe(expected);
  });

  it("different tx hashes produce different digests", () => {
    const tx1 = Transaction.from({
      inputs: [{ previousOutput: { txHash: "0x" + "11".repeat(32), index: 0 } }],
      outputs: [],
      outputsData: [],
    });
    const tx2 = Transaction.from({
      inputs: [{ previousOutput: { txHash: "0x" + "22".repeat(32), index: 0 } }],
      outputs: [],
      outputsData: [],
    });
    expect(computeSighashAllDigest(tx1, [0])).not.toBe(
      computeSighashAllDigest(tx2, [0]),
    );
  });

  it("throws on an empty signing group", () => {
    const tx = Transaction.from({
      inputs: [{ previousOutput: { txHash: "0x" + "aa".repeat(32), index: 0 } }],
      outputs: [],
      outputsData: [],
    });
    expect(() => computeSighashAllDigest(tx, [])).toThrow("empty signing group");
  });
});
