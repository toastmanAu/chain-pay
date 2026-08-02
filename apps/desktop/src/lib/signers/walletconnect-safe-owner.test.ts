import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import { canonicalSafeTxHash, serializeSafePayment, type SafePaymentPayload } from "@/lib/chains/evm/safe";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import {
  WalletConnectSafeOwnerSigner,
  type WalletConnectProviderLike,
} from "./walletconnect-safe-owner";

vi.mock("@/lib/chains/evm/safe-reader", () => ({ readSafeSnapshot: vi.fn() }));

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
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
  owners: [owner.address, other.address],
  threshold: 2,
  version: "1.4.1",
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

function session(account = owner.address, chain = "eip155:11155111", expiry = 2_000_000_000) {
  return {
    expiry,
    namespaces: {
      eip155: {
        accounts: [`${chain}:${account}`],
        chains: [chain],
        methods: ["eth_signTypedData_v4"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  };
}

class FakeProvider implements WalletConnectProviderLike {
  session: ReturnType<typeof session> | undefined;
  readonly request = vi.fn();
  readonly connect = vi.fn(async () => this.session);
  readonly disconnect = vi.fn(async () => { this.session = undefined; });
  readonly setDefaultChain = vi.fn();
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(listener);
    this.handlers.set(event, handlers);
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

beforeEach(() => {
  vi.mocked(readSafeSnapshot).mockResolvedValue({
    chainId: 11155111,
    address: payload.safeAddress,
    owners: [...multisig.owners],
    threshold: multisig.threshold,
    version: multisig.version,
    balanceWei: 1n,
    blockNumber: 1n,
  });
});

describe("WalletConnectSafeOwnerSigner", () => {
  it("fails clearly when the project ID is unavailable", async () => {
    const signer = new WalletConnectSafeOwnerSigner("");
    await expect(signer.isAvailable()).resolves.toBe(false);
    await expect(signer.connect()).rejects.toThrow("VITE_WALLETCONNECT_PROJECT_ID");
  });

  it("emits a pairing URI, connects Sepolia, and signs exact EIP-712 data", async () => {
    const provider = new FakeProvider();
    provider.connect.mockImplementationOnce(async () => {
      provider.emit("display_uri", "wc:test-uri");
      provider.session = session();
      return provider.session;
    });
    provider.request.mockResolvedValue(await owner.sign({ hash: digest }));
    const signer = new WalletConnectSafeOwnerSigner("project", async () => provider, () => 1_000);
    const statuses: string[] = [];
    signer.subscribe((status) => statuses.push(status.state === "connecting" ? status.pairingUri ?? status.state : status.state));

    await expect(signer.connect()).resolves.toMatchObject({ state: "connected", account: owner.address });
    expect(statuses).toContain("wc:test-uri");
    const signature = await signer.sign({
      chain: "evm:11155111",
      digest,
      context: { pending, multisig },
    });
    expect(signature).toMatchObject({ signerHash: owner.address, bytes: expect.any(Uint8Array) });
    expect(provider.request).toHaveBeenCalledWith(
      {
        method: "eth_signTypedData_v4",
        params: [owner.address, expect.any(String)],
      },
      "eip155:11155111",
    );
    const typed = JSON.parse(provider.request.mock.calls[0]![0].params[1]);
    expect(typed).toMatchObject({
      primaryType: "SafeTx",
      domain: { chainId: 11155111, verifyingContract: payload.safeAddress },
      message: payload.tx,
    });
  });

  it("restores a valid session without opening a new pairing", async () => {
    const provider = new FakeProvider();
    provider.session = session();
    const signer = new WalletConnectSafeOwnerSigner("project", async () => provider, () => 1_000);
    await expect(signer.restore()).resolves.toMatchObject({ state: "connected", account: owner.address });
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it("reports expired and wrong-chain sessions explicitly", async () => {
    const expired = new FakeProvider();
    expired.session = session(owner.address, "eip155:11155111", 1);
    const expiredSigner = new WalletConnectSafeOwnerSigner("project", async () => expired, () => 2_000);
    await expect(expiredSigner.restore()).resolves.toEqual({ state: "expired" });
    await expect(
      expiredSigner.sign({ chain: "evm:11155111", digest, context: { pending, multisig } }),
    ).rejects.toThrow("expired");

    const wrong = new FakeProvider();
    wrong.session = session(owner.address, "eip155:1");
    const wrongSigner = new WalletConnectSafeOwnerSigner("project", async () => wrong, () => 1_000);
    await expect(wrongSigner.restore()).resolves.toMatchObject({ state: "error", message: expect.stringContaining("Sepolia") });

    const noTypedData = new FakeProvider();
    noTypedData.session = session();
    noTypedData.session.namespaces.eip155.methods = [];
    const noTypedDataSigner = new WalletConnectSafeOwnerSigner("project", async () => noTypedData, () => 1_000);
    await expect(noTypedDataSigner.restore()).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("typed-data"),
    });
  });

  it("rechecks the live owner set and maps wallet rejection", async () => {
    const provider = new FakeProvider();
    provider.session = session();
    const signer = new WalletConnectSafeOwnerSigner("project", async () => provider, () => 1_000);
    vi.mocked(readSafeSnapshot).mockResolvedValueOnce({
      chainId: 11155111,
      address: payload.safeAddress,
      owners: [other.address],
      threshold: 1,
      version: "1.4.1",
      balanceWei: 1n,
      blockNumber: 1n,
    });
    await expect(
      signer.sign({ chain: "evm:11155111", digest, context: { pending, multisig } }),
    ).rejects.toThrow("configuration changed");

    vi.mocked(readSafeSnapshot).mockResolvedValueOnce({
      chainId: 11155111,
      address: payload.safeAddress,
      owners: [...multisig.owners],
      threshold: multisig.threshold,
      version: multisig.version,
      balanceWei: 1n,
      blockNumber: 1n,
    });
    provider.request.mockRejectedValueOnce({ code: 4001, message: "no" });
    await expect(
      signer.sign({ chain: "evm:11155111", digest, context: { pending, multisig } }),
    ).rejects.toThrow("rejected by the wallet");
  });

  it("refuses a connected account that is not a live Safe owner", async () => {
    const provider = new FakeProvider();
    provider.session = session("0x3333333333333333333333333333333333333333");
    const signer = new WalletConnectSafeOwnerSigner("project", async () => provider, () => 1_000);
    await expect(
      signer.sign({ chain: "evm:11155111", digest, context: { pending, multisig } }),
    ).rejects.toThrow("not a live owner");
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("disconnects and reacts to session deletion without retaining identifiers", async () => {
    const provider = new FakeProvider();
    provider.session = session();
    const signer = new WalletConnectSafeOwnerSigner("project", async () => provider, () => 1_000);
    await signer.restore();
    provider.emit("session_delete", { topic: "secret-topic" });
    expect(signer.snapshot()).toEqual({ state: "disconnected" });
    provider.session = session();
    await signer.disconnect();
    expect(provider.disconnect).toHaveBeenCalled();
    expect(JSON.stringify(signer.snapshot())).not.toContain("topic");
  });
});
