import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import type { Eip1193Provider, SafeSigningFactory } from "./injected-owner-signer";
import { approveSafePayment } from "./injected-owner-signer";
import { canonicalSafeTxHash, serializeSafePayment, type SafePaymentPayload } from "./safe";

const PRIVATE_KEY = `0x${"01".repeat(32)}` as const;
const account = privateKeyToAccount(PRIVATE_KEY);
const SAFE = "0x1234567890123456789012345678901234567890";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const PAYLOAD: SafePaymentPayload = {
  schemaVersion: 1,
  chainId: 11155111,
  safeAddress: SAFE,
  safeVersion: "1.4.1",
  tx: {
    to: RECIPIENT,
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
  owners: [account.address],
  threshold: 2,
  version: "1.4.1",
};
const PENDING: PendingTx = {
  id: "pending-1",
  treasuryId: "treasury-1",
  chain: "evm:11155111",
  state: "awaiting_signature",
  signingDigest: DIGEST,
  outputs: [{ to: RECIPIENT, amount: { asset: "ETH", value: "1000", decimals: 18 } }],
  payloadJson: serializeSafePayment(PAYLOAD),
  signatures: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function provider(accountAddress = account.address, initialChain = "0xaa36a7"): Eip1193Provider {
  let chain = initialChain;
  return {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [accountAddress];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        chain = (params as { chainId: string }[])[0]!.chainId;
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
}

async function signingFactory(options: { digest?: `0x${string}`; signer?: string } = {}): Promise<SafeSigningFactory> {
  const signature = await account.sign({ hash: options.digest ?? DIGEST });
  return vi.fn().mockResolvedValue({
    version: vi.fn().mockReturnValue("1.4.1"),
    hash: vi.fn().mockResolvedValue(options.digest ?? DIGEST),
    signTypedData: vi.fn().mockResolvedValue({ signer: options.signer ?? account.address, data: signature }),
  });
}

describe("approveSafePayment", () => {
  it("recomputes the digest and returns a verified 65-byte owner signature", async () => {
    const result = await approveSafePayment(PENDING, MULTISIG, provider(), await signingFactory());
    expect(result.signerHash).toBe(account.address);
    expect(result.bytes).toHaveLength(65);
  });

  it("switches a wallet from the wrong network before signing", async () => {
    const injected = provider(account.address, "0x1");
    await approveSafePayment(PENDING, MULTISIG, injected, await signingFactory());
    expect(injected.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  });

  it("refuses a connected account that is not a Safe owner", async () => {
    await expect(
      approveSafePayment(
        PENDING,
        MULTISIG,
        provider("0x3333333333333333333333333333333333333333"),
        await signingFactory(),
      ),
    ).rejects.toThrow("not an owner");
  });

  it("refuses to sign when restored payload and digest diverge", async () => {
    await expect(
      approveSafePayment(PENDING, MULTISIG, provider(), await signingFactory({ digest: `0x${"cd".repeat(32)}` })),
    ).rejects.toThrow("hash does not match");
  });

  it("refuses when the review output was mutated", async () => {
    const changed = { ...PENDING, outputs: [{ ...PENDING.outputs[0]!, to: account.address }] };
    await expect(
      approveSafePayment(changed, MULTISIG, provider(), await signingFactory()),
    ).rejects.toThrow("output does not match");
  });
});
