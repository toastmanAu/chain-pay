import { describe, expect, it, vi } from "vitest";
import {
  BitcoinProviderError,
  getBitcoinTransactionStatus,
  providerConfigFromEnvironment,
  scanBitcoinAddresses,
} from "./bitcoin-provider";

const ADDRESS_A = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const ADDRESS_B = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const TIP_HASH = "a".repeat(64);
const BLOCK_HASH = "b".repeat(64);
const ORPHAN_HASH = "c".repeat(64);

function tx(index: number, overrides: Record<string, unknown> = {}) {
  return {
    txid: index.toString(16).padStart(64, "0"),
    vin: [{ prevout: { scriptpubkey_address: ADDRESS_A, value: 1_000 } }],
    vout: [{ scriptpubkey_address: ADDRESS_B, value: 400 }],
    status: {
      confirmed: true,
      block_height: 99,
      block_hash: BLOCK_HASH,
      block_time: 1_700_000_000,
    },
    ...overrides,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Esplora Bitcoin provider", () => {
  it("validates configuration without ever returning provider credentials", () => {
    const config = providerConfigFromEnvironment("btc:mainnet", {
      BITCOIN_MAINNET_ESPLORA_URL: "https://user:password@example.com/api/",
      BITCOIN_MAINNET_ESPLORA_BEARER_TOKEN: "top-secret",
    });
    expect(config).toEqual({ baseUrl: "https://example.com/api", bearerToken: "top-secret" });
    expect(providerConfigFromEnvironment("btc:testnet", {
      BITCOIN_TESTNET_ESPLORA_URL: "http://remote.example/api",
    })).toBeNull();
    expect(providerConfigFromEnvironment("btc:testnet", {
      BITCOIN_TESTNET_ESPLORA_URL: "http://127.0.0.1:3002/api",
    })).toEqual({ baseUrl: "http://127.0.0.1:3002/api" });
  });

  it("paginates and deduplicates history, preserves exact sats, and invalidates orphan confirmations", async () => {
    const firstPage = [
      tx(27, { status: { confirmed: false } }),
      ...Array.from({ length: 25 }, (_, index) => tx(index + 1)),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer top-secret");
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("100");
      if (url.endsWith("/blocks/tip/hash")) return new Response(TIP_HASH);
      if (url.endsWith("/block-height/99")) return new Response(BLOCK_HASH);
      if (url.endsWith(`/address/${ADDRESS_A}`) || url.endsWith(`/address/${ADDRESS_B}`)) {
        return json({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } });
      }
      if (url.includes(`${ADDRESS_A}/txs/chain/`)) return json([tx(26), tx(1)]);
      if (url.endsWith(`/address/${ADDRESS_A}/txs`)) return json(firstPage);
      if (url.endsWith(`/address/${ADDRESS_B}/txs`)) return json([tx(1)]);
      if (url.endsWith(`/address/${ADDRESS_A}/utxo`)) {
        return json([
          {
            txid: "d".repeat(64),
            vout: 0,
            value: 2_100_000_000_000_000,
            status: { confirmed: true, block_height: 99, block_hash: BLOCK_HASH },
          },
        ]);
      }
      if (url.endsWith(`/address/${ADDRESS_B}/utxo`)) {
        return json([
          {
            txid: "e".repeat(64),
            vout: 1,
            value: 7,
            status: { confirmed: true, block_height: 99, block_hash: ORPHAN_HASH },
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A, ADDRESS_B],
      config: { baseUrl: "https://example.com/api", bearerToken: "top-secret" },
      fetchImpl,
    });

    expect(result.activity).toEqual([
      { address: ADDRESS_A, used: true },
      { address: ADDRESS_B, used: true },
    ]);
    expect(result.snapshot.transactions).toHaveLength(27);
    expect(result.snapshot.transactions[0]).toMatchObject({ txid: tx(27).txid, confirmed: false });
    expect(result.snapshot.transactions.find((item) => item.txid === tx(1).txid)?.netValueSats).toBe("-600");
    expect(result.snapshot.balanceSats).toBe("2100000000000000");
    expect(result.snapshot.utxos[0]).toMatchObject({ confirmed: true, confirmations: 2 });
    expect(result.snapshot.utxos).toHaveLength(1);
  });

  it("returns sanitized provider errors that cannot contain URLs, tokens, or response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("top-secret upstream diagnostic", { status: 500 }),
    );
    const promise = scanBitcoinAddresses({
      chain: "btc:mainnet",
      addresses: [ADDRESS_A],
      config: { baseUrl: "https://private.example/api", bearerToken: "top-secret" },
      fetchImpl,
    });
    await expect(promise).rejects.toEqual(
      expect.objectContaining<Partial<BitcoinProviderError>>({
        code: "unavailable",
        message: "Bitcoin provider is unavailable",
      }),
    );
    await promise.catch((error: unknown) => {
      const text = String(error);
      expect(text).not.toContain("top-secret");
      expect(text).not.toContain("private.example");
    });
  });

  it("reports confirmations only when the transaction block remains canonical", async () => {
    const txid = "f".repeat(64);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("104");
      if (url.endsWith(`/tx/${txid}/status`)) {
        return json({ confirmed: true, block_height: 99, block_hash: BLOCK_HASH });
      }
      if (url.endsWith("/block-height/99")) return new Response(BLOCK_HASH);
      return new Response("not found", { status: 404 });
    });
    await expect(
      getBitcoinTransactionStatus({
        txid,
        config: { baseUrl: "https://example.com/api" },
        fetchImpl,
      }),
    ).resolves.toEqual({
      state: "confirmed",
      confirmations: 6,
      blockHeight: 99,
      blockHash: BLOCK_HASH,
    });

    fetchImpl.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/blocks/tip/height")) return new Response("104");
      if (url.includes("/status")) return json({ confirmed: true, block_height: 99, block_hash: ORPHAN_HASH });
      return new Response(BLOCK_HASH);
    });
    await expect(
      getBitcoinTransactionStatus({
        txid,
        config: { baseUrl: "https://example.com/api" },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ state: "pending", confirmations: 0, blockHeight: null });
  });
});
