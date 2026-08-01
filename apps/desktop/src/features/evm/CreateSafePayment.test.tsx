// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Treasury } from "@chain-pay/shared";
import { CreateSafePayment } from "./CreateSafePayment";
import { useTreasuryStore } from "@/stores/treasury";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import { buildNativeSafePayment } from "@/lib/chains/evm/safe";
import type { SafePaymentPayload } from "@/lib/chains/evm/safe";

vi.mock("@/lib/chains/evm/safe-reader", () => ({ readSafeSnapshot: vi.fn() }));
vi.mock("@/lib/chains/evm/safe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chains/evm/safe")>();
  return { ...original, buildNativeSafePayment: vi.fn() };
});

const SAFE = "0x1234567890123456789012345678901234567890" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const TREASURY: Treasury = {
  id: "safe-1",
  label: "Ops Safe",
  multisig: {
    chain: "evm:11155111",
    address: SAFE,
    owners: ["0x1111111111111111111111111111111111111111"],
    threshold: 1,
    version: "1.4.1",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const PAYLOAD: SafePaymentPayload = {
  schemaVersion: 1 as const,
  chainId: 11155111 as const,
  safeAddress: SAFE,
  safeVersion: "1.4.1",
  tx: {
    to: RECIPIENT,
    value: "10000000000000000",
    data: "0x" as const,
    operation: 0 as const,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 4,
  },
};

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [TREASURY], activeTreasuryId: TREASURY.id });
  usePendingTransactionsStore.setState({ transactions: [] });
  vi.mocked(readSafeSnapshot).mockResolvedValue({
    chainId: 11155111,
    address: SAFE,
    owners: ["0x1111111111111111111111111111111111111111"],
    threshold: 1,
    version: "1.4.1",
    balanceWei: 1_000_000_000_000_000_000n,
    blockNumber: 7_000_000n,
  });
  vi.mocked(buildNativeSafePayment).mockResolvedValue({
    payload: PAYLOAD,
    signingDigest: `0x${"ab".repeat(32)}`,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreateSafePayment", () => {
  it("builds and persists a reviewable Safe approval", async () => {
    render(
      <MemoryRouter initialEntries={["/treasury/safe-1/payment/new"]}>
        <Routes>
          <Route path="/treasury/:treasuryId/payment/new" element={<CreateSafePayment />} />
          <Route path="/approvals/:id" element={<div>approval route</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Build and review" }));

    expect(await screen.findByText("approval route")).toBeInTheDocument();
    await waitFor(() => expect(usePendingTransactionsStore.getState().transactions).toHaveLength(1));
    expect(buildNativeSafePayment).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 11155111, address: SAFE }),
      RECIPIENT,
      10_000_000_000_000_000n,
    );
    expect(usePendingTransactionsStore.getState().transactions[0]).toMatchObject({
      treasuryId: "safe-1",
      state: "awaiting_signature",
      outputs: [{ to: RECIPIENT, amount: { asset: "ETH", value: PAYLOAD.tx.value, decimals: 18 } }],
    });
  });

  it("refuses an amount above the current Safe balance", async () => {
    vi.mocked(readSafeSnapshot).mockResolvedValueOnce({
      chainId: 11155111,
      address: SAFE,
      owners: [],
      threshold: 1,
      version: "1.4.1",
      balanceWei: 1n,
      blockNumber: 7_000_000n,
    });
    render(
      <MemoryRouter initialEntries={["/treasury/safe-1/payment/new"]}>
        <Routes><Route path="/treasury/:treasuryId/payment/new" element={<CreateSafePayment />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Build and review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Safe balance is");
    expect(buildNativeSafePayment).not.toHaveBeenCalled();
  });
});
