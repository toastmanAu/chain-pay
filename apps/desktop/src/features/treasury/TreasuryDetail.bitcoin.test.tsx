// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BitcoinWatchTreasury } from "@chain-pay/shared";
import { TreasuryDetail } from "./TreasuryDetail";
import { useTreasuryStore } from "@/stores/treasury";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";
import { useBitcoinBroadcastStore } from "@/stores/bitcoin-broadcast";

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

const statusMock = vi.fn();
const reviewMock = vi.fn();
const confirmMock = vi.fn();
const transactionStatusMock = vi.fn();

beforeEach(() => {
  statusMock.mockReset().mockResolvedValue({ configured: false });
  reviewMock.mockReset();
  confirmMock.mockReset();
  transactionStatusMock.mockReset();
  useTreasuryStore.setState({ treasuries: [TREASURY], activeTreasuryId: TREASURY.id });
  useBitcoinWatchStore.setState({ records: {} });
  useBitcoinBroadcastStore.setState({ records: {} });
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
      status: statusMock,
      scan: vi.fn(async (request: { addresses: string[] }) => ({
        activity: request.addresses.map((address) => ({ address, used: false })),
        snapshot: {
          tipHeight: 900_000,
          tipHash: "a".repeat(64),
          balanceSats: "0",
          addresses: request.addresses,
          utxos: [],
          transactions: [],
        },
      })),
      transactionStatus: transactionStatusMock,
      reviewBroadcast: reviewMock,
      confirmBroadcast: confirmMock,
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
    expect(screen.getByText(/never constructs or signs Bitcoin transactions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review signed transaction/i })).toBeDisabled();
  });

  it("shows immutable review, warning, explicit confirmation, and submitted receipt states", async () => {
    statusMock.mockResolvedValue({ configured: true });
    const review = {
      digest: "e".repeat(64), treasuryId: TREASURY.id, chain: "btc:mainnet" as const,
      txid: "f".repeat(64), wtxid: "1".repeat(64), version: 2, lockTime: 0,
      sizeBytes: 120, weight: 480, vsize: 120, inputValueSats: "10000", outputValueSats: "9000",
      feeSats: "1000", feeRateSatsPerVbyte: "8.333", tipHeight: 900_000, tipHash: "a".repeat(64),
      watchSetHash: "3".repeat(64),
      inputs: [{ txid: "2".repeat(64), vout: 0, address: "bc1ptest", valueSats: "10000", scriptType: "p2tr-keypath" as const, watched: true }],
      outputs: [{ vout: 0, address: "bc1pexternal", valueSats: "9000", scriptType: "p2tr" as const, watched: false, changeCandidate: false }],
      warnings: ["1 input is outside the selected treasury; ownership is unverified"],
    };
    reviewMock.mockResolvedValue({ ok: true, review });
    confirmMock.mockResolvedValue({ ok: true, receipt: { txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-03T00:00:00.000Z" } });
    transactionStatusMock.mockResolvedValue({ state: "pending", confirmations: 0, blockHeight: null, blockHash: null });
    renderBitcoinDetail();

    const textarea = screen.getByRole("textbox", { name: /fully signed raw transaction/i });
    fireEvent.change(textarea, { target: { value: "02000000" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /review signed transaction/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /review signed transaction/i }));
    expect(await screen.findByText(review.digest)).toBeInTheDocument();
    expect(screen.getByText(/ownership is unverified/i)).toBeInTheDocument();
    const confirmation = screen.getByRole("checkbox");
    const submit = screen.getByRole("button", { name: /confirm and broadcast/i });
    expect(submit).toBeDisabled();
    fireEvent.click(confirmation);
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(await screen.findByText("Submitted")).toBeInTheDocument();
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ reviewDigest: review.digest, rawTxHex: "02000000" }));
  });

  it("surfaces provider rejection without exposing provider diagnostics", async () => {
    statusMock.mockResolvedValue({ configured: true });
    reviewMock.mockResolvedValue({ ok: false, error: { code: "provider_rejected", message: "Bitcoin provider rejected the transaction" } });
    renderBitcoinDetail();
    fireEvent.change(screen.getByRole("textbox", { name: /fully signed raw transaction/i }), { target: { value: "00" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /review signed transaction/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /review signed transaction/i }));
    await waitFor(() => expect(screen.getByText("Bitcoin provider rejected the transaction")).toBeInTheDocument());
    expect(screen.queryByText(/private\.example|top-secret/i)).not.toBeInTheDocument();
  });

  it.each([
    ["provider_unavailable", "Bitcoin provider is unavailable", "Provider unavailable"],
    ["already_known", "Transaction is already known to the selected Bitcoin provider", "Already broadcast"],
  ] as const)("renders the %s workflow state", async (code, message, stateLabel) => {
    statusMock.mockResolvedValue({ configured: true });
    reviewMock.mockResolvedValue({ ok: false, error: { code, message } });
    renderBitcoinDetail();
    fireEvent.change(screen.getByRole("textbox", { name: /fully signed raw transaction/i }), { target: { value: "00" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /review signed transaction/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /review signed transaction/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText(`State: ${stateLabel}`)).toBeInTheDocument();
  });
});

function renderBitcoinDetail(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/treasury/btc-1"]}>
        <Routes><Route path="/treasury/:id" element={<TreasuryDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
