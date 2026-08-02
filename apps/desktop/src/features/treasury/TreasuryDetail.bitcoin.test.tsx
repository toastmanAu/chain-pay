// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BitcoinWatchTreasury } from "@chain-pay/shared";
import { TreasuryDetail } from "./TreasuryDetail";
import { useTreasuryStore } from "@/stores/treasury";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";

const TREASURY: BitcoinWatchTreasury = {
  id: "btc-1",
  kind: "bitcoin-watch",
  label: "Cold reserve",
  createdAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-03T00:00:00Z",
  watch: {
    chain: "btc:mainnet",
    gapLimit: 20,
    source: {
      kind: "descriptor",
      descriptor: "tr(xpub…/0/*)#checksum",
      scriptType: "p2tr",
      extendedPublicKey:
        "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ",
      derivationPath: [0],
    },
  },
};

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [TREASURY], activeTreasuryId: TREASURY.id });
  useBitcoinWatchStore.setState({ records: {} });
  useBitcoinWatchStore.getState().ensure(TREASURY.id, TREASURY.watch);
  useBitcoinWatchStore.getState().commitSync(TREASURY.id, {
    tipHeight: 900_000,
    tipHash: "a".repeat(64),
    balanceSats: "123456789",
    addresses: ["bc1ptest"],
    utxos: [
      {
        txid: "b".repeat(64),
        vout: 1,
        address: "bc1ptest",
        valueSats: "123456789",
        confirmed: true,
        blockHeight: 899_999,
        blockHash: "c".repeat(64),
        confirmations: 2,
      },
    ],
    transactions: [
      {
        txid: "d".repeat(64),
        netValueSats: "123456789",
        confirmed: true,
        blockHeight: 899_999,
        blockHash: "c".repeat(64),
        blockTime: 1_700_000_000,
        confirmations: 2,
      },
    ],
  });
  (window as unknown as { chainpay: { bitcoin: unknown } }).chainpay = {
    bitcoin: {
      status: vi.fn(async () => ({ configured: false })),
      scan: vi.fn(),
      transactionStatus: vi.fn(),
    },
  };
});

afterEach(cleanup);

describe("Bitcoin treasury detail", () => {
  it("renders exact balance, UTXOs, history, receive address, and unavailable-provider state", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/treasury/btc-1"]}>
          <Routes><Route path="/treasury/:id" element={<TreasuryDetail />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect((await screen.findAllByText("1.23456789 BTC"))).toHaveLength(2);
    expect(screen.getByText(/bbbbbbbbbbbb…:1/)).toBeInTheDocument();
    expect(screen.getByText("+1.23456789 BTC")).toBeInTheDocument();
    expect(screen.getByText(/bc1p5cyxnuxmeuwuv/)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("BITCOIN_MAINNET_ESPLORA_URL");
    expect(screen.getByText(/cannot construct, sign, or broadcast/i)).toBeInTheDocument();
  });
});
