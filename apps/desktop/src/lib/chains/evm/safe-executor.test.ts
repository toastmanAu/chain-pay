import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Eip1193Provider } from "./injected-owner-signer";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import { canonicalSafeTxHash, serializeSafePayment, type SafePaymentPayload } from "./safe";
import { executeSafePayment, type SafeExecutionFactory } from "./safe-executor";

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const otherOwner = privateKeyToAccount(`0x${"02".repeat(32)}`);
const SAFE = "0x1234567890123456789012345678901234567890";
const PAYLOAD: SafePaymentPayload = {
  schemaVersion: 1,
  chainId: 11155111,
  safeAddress: SAFE,
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
const DIGEST = canonicalSafeTxHash(PAYLOAD);
const MULTISIG: EvmMultisig = {
  chain: "evm:11155111",
  address: SAFE,
  owners: [owner.address, otherOwner.address],
  threshold: 2,
  version: "1.4.1",
};

async function pending(): Promise<PendingTx> {
  const first = await owner.sign({ hash: DIGEST });
  const second = await otherOwner.sign({ hash: DIGEST });
  return {
    id: "p1",
    treasuryId: "t1",
    chain: "evm:11155111",
    state: "ready_to_broadcast",
    signingDigest: DIGEST,
    outputs: [{ to: PAYLOAD.tx.to, amount: { asset: "ETH", value: "1000", decimals: 18 } }],
    payloadJson: serializeSafePayment(PAYLOAD),
    signatures: [
      { signerHash: owner.address, bytes: hexToBytes(first), signedAt: 1 },
      { signerHash: otherOwner.address, bytes: hexToBytes(second), signedAt: 2 },
    ],
    createdAt: "2026-08-02T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
  };
}

function provider(account = owner.address): Eip1193Provider {
  return {
    request: vi.fn(async ({ method }) => {
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0xaa36a7";
      throw new Error(`unexpected ${method}`);
    }),
  };
}

function factory(overrides: Record<string, unknown> = {}): SafeExecutionFactory {
  return vi.fn().mockResolvedValue({
    version: vi.fn().mockReturnValue("1.4.1"),
    owners: vi.fn().mockResolvedValue(MULTISIG.owners),
    threshold: vi.fn().mockResolvedValue(MULTISIG.threshold),
    hash: vi.fn().mockResolvedValue(DIGEST),
    execute: vi.fn().mockResolvedValue(`0x${"cd".repeat(32)}`),
    ...overrides,
  });
}

describe("executeSafePayment", () => {
  it("verifies, assembles, and executes threshold owner signatures", async () => {
    const execute = vi.fn().mockResolvedValue(`0x${"cd".repeat(32)}`);
    const executionFactory = factory({ execute });
    await expect(executeSafePayment(await pending(), MULTISIG, provider(), executionFactory)).resolves.toBe(
      `0x${"cd".repeat(32)}`,
    );
    expect(execute).toHaveBeenCalledWith(
      PAYLOAD.tx,
      expect.arrayContaining([
        expect.objectContaining({ signer: owner.address }),
        expect.objectContaining({ signer: otherOwner.address }),
      ]),
    );
  });

  it("refuses execution below threshold", async () => {
    const transaction = await pending();
    transaction.signatures = transaction.signatures.slice(0, 1);
    await expect(executeSafePayment(transaction, MULTISIG, provider(), factory())).rejects.toThrow(
      "requires 2 owner signatures",
    );
  });

  it("refuses a tampered stored signature", async () => {
    const transaction = await pending();
    const bytes = transaction.signatures[0]!.bytes;
    bytes[0] = bytes[0]! ^ 0xff;
    await expect(executeSafePayment(transaction, MULTISIG, provider(), factory())).rejects.toThrow(
      "does not recover",
    );
  });

  it("requires an owner wallet to pay execution gas", async () => {
    await expect(
      executeSafePayment(
        await pending(),
        MULTISIG,
        provider("0x3333333333333333333333333333333333333333"),
        factory(),
      ),
    ).rejects.toThrow("Connect a Safe owner");
  });

  it("refuses execution after an on-chain owner configuration change", async () => {
    await expect(
      executeSafePayment(
        await pending(),
        MULTISIG,
        provider(),
        factory({ threshold: vi.fn().mockResolvedValue(1) }),
      ),
    ).rejects.toThrow("owner configuration changed");
  });
});

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}
