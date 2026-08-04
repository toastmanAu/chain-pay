import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import {
  SolanaProviderError,
  getSolanaTransactionStatus,
  parseSolanaAddress,
  parseSolanaSignature,
  scanSolanaAddress,
  solanaProviderConfigFromEnvironment,
} from "./solana-provider";

const address = bs58.encode(new Uint8Array(32));
const otherAddress = bs58.encode(new Uint8Array(32).fill(2));
const signature = bs58.encode(new Uint8Array(64).fill(3));
const blockhashA = bs58.encode(new Uint8Array(32).fill(4));
const blockhashB = bs58.encode(new Uint8Array(32).fill(5));
const config = { rpcUrl: "https://rpc.example.test", bearerToken: "never-render-this" };

describe("Solana provider", () => {
  it("loads only secure main-process configuration and removes URL credentials/query data", () => {
    expect(solanaProviderConfigFromEnvironment("sol:devnet", {
      SOLANA_DEVNET_RPC_URL: "https://user:pass@rpc.example.test/path?api-key=secret#fragment",
      SOLANA_DEVNET_RPC_BEARER_TOKEN: " bearer-secret ",
    })).toEqual({ rpcUrl: "https://rpc.example.test/path", bearerToken: "bearer-secret" });
    expect(solanaProviderConfigFromEnvironment("sol:mainnet", { SOLANA_MAINNET_RPC_URL: "http://rpc.example.test" })).toBeNull();
    expect(solanaProviderConfigFromEnvironment("sol:devnet", { SOLANA_DEVNET_RPC_URL: "http://127.0.0.1:8899" }))
      .toEqual({ rpcUrl: "http://127.0.0.1:8899" });
  });

  it("validates canonical public addresses and transaction signatures by byte length", () => {
    expect(parseSolanaAddress(address)).toBe(address);
    expect(parseSolanaSignature(signature)).toBe(signature);
    expect(() => parseSolanaAddress(signature)).toThrow(/address is invalid/);
    expect(() => parseSolanaSignature(address)).toThrow(/signature is invalid/);
  });

  it("preserves exact lamports above Number.MAX_SAFE_INTEGER and attributes fees", async () => {
    const fetchImpl = rpcFetch((method, _params, id) => {
      if (method === "getLatestBlockhash") {
        const call = latestCalls++;
        return result(id, { context: { slot: call === 0 ? 100 : 102 }, value: { blockhash: call === 0 ? blockhashA : blockhashB, lastValidBlockHeight: 250 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 101 }, value: big("9007199254740993") });
      if (method === "getSignaturesForAddress") return result(id, [{ signature, slot: 99, err: null, memo: null, blockTime: 1_700_000_000, confirmationStatus: "confirmed" }]);
      if (method === "getTransaction") return result(id, {
        slot: 99,
        blockTime: 1_700_000_001,
        version: "legacy",
        meta: {
          err: null,
          fee: big("9007199254740995"),
          preBalances: [big("9007199254740993"), 0],
          postBalances: [big("9007199254741000"), 0],
        },
        transaction: { signatures: [signature], message: { accountKeys: [address, otherAddress] } },
      });
      throw new Error(`unexpected ${method}`);
    });
    let latestCalls = 0;

    const response = await scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl });

    expect(response.snapshot.balanceLamports).toBe("9007199254740993");
    expect(response.snapshot.transactions[0]).toMatchObject({
      netLamports: "7",
      feeLamports: "9007199254740995",
      feePaidByWatched: true,
      state: "confirmed",
    });
    expect(response.snapshot.slot).toBe("102");
    expect(JSON.stringify(response)).not.toContain("never-render-this");
  });

  it("maps finalized, failed, and unknown signature status without fabricating confirmations", async () => {
    const finalized = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [{ slot: 42, confirmations: null, err: null, confirmationStatus: "finalized" }] })),
    });
    expect(finalized).toEqual({ state: "finalized", slot: "42", confirmations: null });

    const failed = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [{ slot: 43, confirmations: 0, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }] })),
    });
    expect(failed.state).toBe("failed");

    const unknown = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [null] })),
    });
    expect(unknown).toEqual({ state: "unknown", slot: null, confirmations: null });
  });

  it("paginates newest-first with before cursors and deduplicates overlapping pages", async () => {
    const signatures = Array.from({ length: 26 }, (_, index) => bs58.encode(new Uint8Array(64).fill(index + 10)));
    const historyParams: unknown[][] = [];
    let latestCalls = 0;
    const fetchImpl = rpcFetch((method, params, id) => {
      if (method === "getLatestBlockhash") {
        latestCalls++;
        return result(id, { context: { slot: latestCalls === 1 ? 100 : 101 }, value: { blockhash: latestCalls === 1 ? blockhashA : blockhashB, lastValidBlockHeight: 200 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 100 }, value: 0 });
      if (method === "getSignaturesForAddress") {
        historyParams.push(params);
        const page = historyParams.length === 1 ? signatures.slice(0, 25) : [signatures[24]!, signatures[25]!];
        return result(id, page.map((item, index) => ({ signature: item, slot: 99 - index, err: null, memo: null, blockTime: null, confirmationStatus: "confirmed" })));
      }
      if (method === "getTransaction") return result(id, null);
      throw new Error(`unexpected ${method}`);
    });

    const response = await scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl });

    expect(response.snapshot.transactions).toHaveLength(26);
    expect(response.snapshot.transactions.map((item) => item.signature)).toEqual(signatures);
    expect(historyParams[1]?.[1]).toMatchObject({ before: signatures[24], limit: 25, commitment: "confirmed" });
    expect(response.snapshot.historyTruncated).toBe(false);
  });

  it("rejects a provider context that moves backwards", async () => {
    let latestCalls = 0;
    const fetchImpl = rpcFetch((method, _params, id) => {
      if (method === "getLatestBlockhash") {
        latestCalls++;
        return result(id, { context: { slot: latestCalls === 1 ? 100 : 99 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 100 }, value: 0 });
      if (method === "getSignaturesForAddress") return result(id, []);
      throw new Error("unexpected method");
    });
    await expect(scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects malformed and oversized responses", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    await expect(getSolanaTransactionStatus({ signature, config, fetchImpl: malformed })).rejects.toMatchObject({ code: "invalid_response" });
    const oversized = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": String(16 * 1024 * 1024 + 1) } })) as unknown as typeof fetch;
    await expect(getSolanaTransactionStatus({ signature, config, fetchImpl: oversized })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sanitizes transport failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await getSolanaTransactionStatus({ signature, config, fetchImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SolanaProviderError);
    expect(caught).toMatchObject({ code: "unavailable", message: "Solana provider is unavailable" });
    expect(JSON.stringify(caught)).not.toContain("never-render-this");
    expect(JSON.stringify(caught)).not.toContain("rpc.example.test");
  });
});

type BigToken = { __rawBig: string };
function big(value: string): BigToken { return { __rawBig: value }; }

function result(id: number, value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: value }).replace(/\{"__rawBig":"(\d+)"\}/g, "$1");
}

function rpcFetch(handler: (method: string, params: unknown[], id: number) => string): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
    return new Response(handler(request.method, request.params, request.id), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}
