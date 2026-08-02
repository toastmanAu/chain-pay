import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import { canonicalSafeTxHash, serializeSafePayment, type SafePaymentPayload } from "./safe";
import { hexToBytes } from "./safe-owner-signature";
import { parseSafeApproval, serializeSafeApproval } from "./safe-approval-interchange";

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const payload: SafePaymentPayload = {
  schemaVersion: 1,
  chainId: 11155111,
  safeAddress: "0x1234567890123456789012345678901234567890",
  safeVersion: "1.4.1",
  tx: {
    to: "0x2222222222222222222222222222222222222222",
    value: "1000",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 3,
  },
};
const digest = canonicalSafeTxHash(payload);
const multisig: EvmMultisig = {
  chain: "evm:11155111",
  address: payload.safeAddress,
  owners: [owner.address],
  threshold: 1,
  version: payload.safeVersion,
};
const pending: PendingTx = {
  id: "p1",
  treasuryId: "t1",
  chain: "evm:11155111",
  state: "awaiting_signature",
  signingDigest: digest,
  outputs: [{ to: payload.tx.to, amount: { asset: "ETH", value: payload.tx.value, decimals: 18 } }],
  payloadJson: serializeSafePayment(payload),
  signatures: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

async function envelope(): Promise<string> {
  const data = await owner.sign({ hash: digest });
  return serializeSafeApproval({
    pending,
    multisig,
    signature: { signerHash: owner.address, bytes: hexToBytes(data), signedAt: 1 },
  });
}

describe("Safe approval interchange", () => {
  it("round-trips only the versioned signature binding", async () => {
    const text = await envelope();
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schema",
      "version",
      "chainId",
      "safeAddress",
      "safeTxHash",
      "signer",
      "signature",
    ]);
    await expect(parseSafeApproval({ text, pending, multisig, signedAt: 123 })).resolves.toMatchObject({
      signerHash: owner.address,
      bytes: expect.any(Uint8Array),
      signedAt: 123,
    });
    expect(text).not.toContain("payloadJson");
    expect(text).not.toContain("session");
  });

  it("rejects changed Safe, SafeTx, signer, signature, and unknown fields", async () => {
    const original = JSON.parse(await envelope());
    for (const changed of [
      { ...original, chainId: 1 },
      { ...original, safeAddress: "0x3333333333333333333333333333333333333333" },
      { ...original, safeTxHash: `0x${"cd".repeat(32)}` },
      { ...original, signer: "0x3333333333333333333333333333333333333333" },
      { ...original, signature: `${original.signature.slice(0, -4)}001b` },
      { ...original, sessionTopic: "must-not-be-accepted" },
    ]) {
      await expect(parseSafeApproval({ text: JSON.stringify(changed), pending, multisig })).rejects.toThrow();
    }
  });

  it("cannot replay an approval onto a changed payment payload", async () => {
    const changedPayload = { ...payload, tx: { ...payload.tx, value: "2000" } };
    const changedPending = {
      ...pending,
      signingDigest: canonicalSafeTxHash(changedPayload),
      payloadJson: serializeSafePayment(changedPayload),
      outputs: [{ ...pending.outputs[0]!, amount: { ...pending.outputs[0]!.amount, value: "2000" } }],
    };
    await expect(
      parseSafeApproval({ text: await envelope(), pending: changedPending, multisig }),
    ).rejects.toThrow("different SafeTx");
  });
});
