import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import { solanaAdapter } from "./adapter";

const address = bs58.encode(new Uint8Array(32).fill(7));
const signature = bs58.encode(new Uint8Array(64).fill(8)) as `0x${string}`;

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe("Solana ChainAdapter", () => {
  it("validates canonical 32-byte public addresses", () => {
    const adapter = solanaAdapter("sol:devnet");
    expect(adapter.validateAddress(address)).toEqual({ valid: true, normalized: address });
    expect(adapter.validateAddress(bs58.encode(new Uint8Array(64)))).toMatchObject({ valid: false });
  });

  it("reads exact lamports and maps finalized status through IPC", async () => {
    const scan = vi.fn(async () => ({ snapshot: { balanceLamports: "9007199254740993" } }));
    const transactionStatus = vi.fn(async () => ({ state: "finalized" as const, slot: "9007199254740994", confirmations: null }));
    (globalThis as unknown as { window: { chainpay: { solana: unknown } } }).window = { chainpay: { solana: { status: vi.fn(), scan, transactionStatus } } };
    const adapter = solanaAdapter("sol:devnet");
    await expect(adapter.getBalance(address)).resolves.toEqual({ asset: "SOL", value: 9_007_199_254_740_993n, decimals: 9 });
    await expect(adapter.getTransactionStatus(signature)).resolves.toEqual({ hash: signature, state: "confirmed", confirmations: 0, blockNumber: 9_007_199_254_740_994n });
  });

  it("refuses every spending surface", async () => {
    const adapter = solanaAdapter("sol:mainnet");
    const request = { from: address, outputs: [{ to: address, amount: { asset: "SOL", value: 1n, decimals: 9 } }] };
    await expect(adapter.estimateFee(request)).rejects.toThrow(/watch-only/i);
    await expect(adapter.createUnsignedTransaction(request)).rejects.toThrow(/watch-only/i);
    await expect(adapter.broadcastTransaction({ payload: "secret" })).rejects.toThrow(/watch-only/i);
  });
});
