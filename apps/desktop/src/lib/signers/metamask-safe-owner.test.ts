import { describe, expect, it, vi } from "vitest";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import type { Eip1193Provider, SafeSigningFactory } from "@/lib/chains/evm/injected-owner-signer";
import { MetaMaskSafeOwnerSigner } from "./metamask-safe-owner";

const OWNER = "0x1111111111111111111111111111111111111111";
const DIGEST = `0x${"ab".repeat(32)}`;
const pending = {
  id: "p1",
  treasuryId: "t1",
  chain: "evm:11155111",
  state: "awaiting_signature",
  signingDigest: DIGEST,
  outputs: [],
  payloadJson: "{}",
  signatures: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
} satisfies PendingTx;
const multisig = {
  chain: "evm:11155111",
  address: "0x1234567890123456789012345678901234567890",
  owners: [OWNER],
  threshold: 1,
  version: "1.4.1",
} satisfies EvmMultisig;

describe("MetaMaskSafeOwnerSigner", () => {
  it("declares an interactive Sepolia EIP-712 transport", async () => {
    const signer = new MetaMaskSafeOwnerSigner(undefined);
    expect(signer.kind).toBe("metamask");
    expect(signer.capabilities).toEqual({ chains: ["evm:11155111"], interactive: true, typedData: true });
    await expect(signer.isAvailable()).resolves.toBe(false);
  });

  it("rejects mismatched requests before touching the provider", async () => {
    const provider = { request: vi.fn() } satisfies Eip1193Provider;
    const factory = vi.fn() as SafeSigningFactory;
    const signer = new MetaMaskSafeOwnerSigner(provider, factory);
    await expect(
      signer.sign({ chain: "evm:11155111", digest: `0x${"cd".repeat(32)}`, context: { pending, multisig } }),
    ).rejects.toThrow("digest does not match");
    expect(provider.request).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
