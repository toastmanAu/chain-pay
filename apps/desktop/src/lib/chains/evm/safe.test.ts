import { describe, expect, it, vi } from "vitest";
import type { SafeConfig, SafeProtocolFactory, SafeTx } from "./safe";
import { buildNativeSafePayment, canonicalSafeTxHash, parseSafePayment, safeTxHash, serializeSafePayment } from "./safe";

const SAFE = "0x1234567890123456789012345678901234567890" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const TX: SafeTx = {
  to: RECIPIENT,
  value: "1000000000000000",
  data: "0x",
  operation: 0,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce: 7,
};
const CFG: SafeConfig = {
  chainId: 11155111,
  address: SAFE,
  owners: ["0x1111111111111111111111111111111111111111"],
  threshold: 1,
  version: "1.4.1",
};
const PAYLOAD = {
  schemaVersion: 1 as const,
  chainId: 11155111,
  safeAddress: SAFE,
  safeVersion: "1.4.1",
  tx: TX,
};
const DIGEST = canonicalSafeTxHash(PAYLOAD);

function factory(overrides: Partial<Awaited<ReturnType<SafeProtocolFactory>>> = {}): SafeProtocolFactory {
  return vi.fn().mockResolvedValue({
    chainId: vi.fn().mockResolvedValue(11155111),
    version: vi.fn().mockReturnValue("1.4.1"),
    createNativeTransfer: vi.fn().mockResolvedValue(TX),
    hash: vi.fn().mockResolvedValue(DIGEST),
    ...overrides,
  });
}

describe("Safe payment construction", () => {
  it("builds a serialisable native transfer and canonical digest", async () => {
    const result = await buildNativeSafePayment(CFG, RECIPIENT, 1_000_000_000_000_000n, factory());
    expect(result).toEqual({
      payload: { schemaVersion: 1, chainId: 11155111, safeAddress: SAFE, safeVersion: "1.4.1", tx: TX },
      signingDigest: DIGEST,
    });
    expect(parseSafePayment(serializeSafePayment(result.payload))).toEqual(result.payload);
  });

  it("rejects a wrong RPC chain before creating a transaction", async () => {
    await expect(
      buildNativeSafePayment(CFG, RECIPIENT, 1n, factory({ chainId: vi.fn().mockResolvedValue(1) })),
    ).rejects.toThrow("RPC chain mismatch");
  });

  it("rejects Protocol Kit output that changes the reviewed transfer", async () => {
    await expect(
      buildNativeSafePayment(
        CFG,
        RECIPIENT,
        1_000_000_000_000_000n,
        factory({ createNativeTransfer: vi.fn().mockResolvedValue({ ...TX, data: "0x1234" }) }),
      ),
    ).rejects.toThrow("native ETH call with empty calldata");
  });

  it("recomputes a digest from restored transaction data", async () => {
    await expect(safeTxHash(CFG, TX, factory())).resolves.toBe(DIGEST);
  });

  it("matches the canonical Safe v1.4.1 EIP-712 known answer", () => {
    expect(canonicalSafeTxHash(PAYLOAD)).toBe(
      "0x2659fe58d96bfc8360ad18e40b1dc13aa3645d92836b37c3aeed0f37334d17e1",
    );
  });

  it("rejects malformed restored payloads", () => {
    expect(() => parseSafePayment('{"schemaVersion":1,"chainId":1}')).toThrow("Invalid Safe payment payload");
  });
});
