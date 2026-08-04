// @vitest-environment jsdom
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SolanaWatchTreasury } from "@chain-pay/shared";
import { TreasuryDetail } from "./TreasuryDetail";
import { useTreasuryStore } from "@/stores/treasury";
import { useSolanaWatchStore } from "@/stores/solana-watch";

const address = bs58.encode(new Uint8Array(32).fill(10));
const signature = bs58.encode(new Uint8Array(64).fill(11));
const treasury: SolanaWatchTreasury = {
  id: "sol-1",
  kind: "solana-watch",
  label: "SOL reserve",
  watch: { chain: "sol:devnet", address },
  createdAt: "2026-08-04T00:00:00Z",
  updatedAt: "2026-08-04T00:00:00Z",
};
const status = vi.fn();
const transactionStatus = vi.fn();

beforeEach(() => {
  status.mockReset().mockResolvedValue({ configured: false });
  transactionStatus.mockReset().mockResolvedValue({ state: "confirmed", slot: "9007199254740992", confirmations: 1 });
  useTreasuryStore.setState({ treasuries: [treasury], activeTreasuryId: treasury.id });
  useSolanaWatchStore.setState({ records: {} });
  useSolanaWatchStore.getState().ensure(treasury.id, treasury.watch);
  useSolanaWatchStore.getState().commitSync(treasury.id, {
    address,
    slot: "9007199254740993",
    blockhash: bs58.encode(new Uint8Array(32).fill(12)),
    lastValidBlockHeight: "9007199254741099",
    balanceLamports: "1234567891",
    historyCursor: null,
    historyTruncated: false,
    transactions: [{ signature, slot: "9007199254740992", blockTime: 1_700_000_000, state: "finalized", netLamports: "1000000001", feeLamports: "5000", feePaidByWatched: false }],
  });
  (window as unknown as { chainpay: { solana: unknown } }).chainpay = {
    solana: { status, scan: vi.fn(), transactionStatus },
  };
});

afterEach(cleanup);

describe("Solana treasury detail", () => {
  it("renders exact balance, history, fee attribution, provider error, and rollback state", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/treasury/sol-1"]}>
          <Routes><Route path="/treasury/:id" element={<TreasuryDetail />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("1.234567891 SOL")).toBeInTheDocument();
    expect(screen.getByText("+1.000000001 SOL")).toBeInTheDocument();
    expect(screen.getByText(/paid by another account/i)).toBeInTheDocument();
    expect(screen.getByText(address)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("SOLANA_DEVNET_RPC_URL");

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(transactionStatus).toHaveBeenCalledWith({ chain: "sol:devnet", signature }));
    expect(await screen.findByText(/Chain rollback detected/i)).toBeInTheDocument();
  });
});
