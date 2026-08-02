// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PendingTx, Treasury } from "@chain-pay/shared";
import { SafeApprovalDetail } from "./SafeApprovalDetail";
import { useTreasuryStore } from "@/stores/treasury";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { serializeSafePayment, type SafePaymentPayload } from "@/lib/chains/evm/safe";

const { signMock, executeMock, statusMock, postAccountingMock } = vi.hoisted(() => ({
  signMock: vi.fn(),
  executeMock: vi.fn(),
  statusMock: vi.fn(),
  postAccountingMock: vi.fn(),
}));
vi.mock("@/lib/signers/metamask-safe-owner", () => ({
  MetaMaskSafeOwnerSigner: class {
    isAvailable = vi.fn().mockResolvedValue(true);
    sign = signMock;
  },
}));
vi.mock("@/lib/chains/evm/safe-executor", () => ({ executeSafePayment: executeMock }));
vi.mock("@/lib/chains/evm/execution-status", () => ({ readEvmExecutionStatus: statusMock }));
vi.mock("@/lib/accounting/evm-safe-accounting", () => ({
  postConfirmedSafePayment: postAccountingMock,
}));

const OWNER = "0x1111111111111111111111111111111111111111";
const SAFE = "0x1234567890123456789012345678901234567890";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const PAYLOAD: SafePaymentPayload = {
  schemaVersion: 1,
  chainId: 11155111,
  safeAddress: SAFE,
  safeVersion: "1.4.1",
  tx: {
    to: RECIPIENT,
    value: "10000000000000000",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 4,
  },
};
const TREASURY: Treasury = {
  id: "safe-1",
  label: "Ops Safe",
  multisig: {
    chain: "evm:11155111",
    address: SAFE,
    owners: [OWNER],
    threshold: 1,
    version: "1.4.1",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const PENDING: PendingTx = {
  id: "pending-1",
  treasuryId: TREASURY.id,
  chain: "evm:11155111",
  state: "awaiting_signature",
  signingDigest: `0x${"ab".repeat(32)}`,
  outputs: [{ to: RECIPIENT, amount: { asset: "ETH", value: PAYLOAD.tx.value, decimals: 18 } }],
  payloadJson: serializeSafePayment(PAYLOAD),
  signatures: [],
  accounting: { payeeId: "vendor-1", fiat: { currency: "USD", minor: 2550n } },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [TREASURY], activeTreasuryId: TREASURY.id });
  usePendingTransactionsStore.setState({ transactions: [PENDING] });
  signMock.mockResolvedValue({
    signerHash: OWNER,
    bytes: new Uint8Array(65).fill(7),
  });
  executeMock.mockResolvedValue(`0x${"cd".repeat(32)}`);
  statusMock.mockResolvedValue({ state: "pending" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SafeApprovalDetail", () => {
  it("renders the exact payment fields before signing", () => {
    renderDetail();
    expect(screen.getByText("0.01 ETH")).toBeInTheDocument();
    expect(screen.getByText(RECIPIENT)).toBeInTheDocument();
    expect(screen.getByText(PENDING.signingDigest)).toBeInTheDocument();
    expect(screen.getByText("CALL (0)")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("records the owner signature and advances the approval lifecycle", async () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Connect owner wallet and approve" }));
    await waitFor(() =>
      expect(usePendingTransactionsStore.getState().findById(PENDING.id)?.state).toBe("ready_to_broadcast"),
    );
    expect(await screen.findByText(/signature threshold met/i)).toBeInTheDocument();
    expect(screen.getByText(OWNER)).toBeInTheDocument();
  });

  it("submits a threshold-approved Safe payment and begins confirmation tracking", async () => {
    usePendingTransactionsStore.setState({
      transactions: [
        {
          ...PENDING,
          state: "ready_to_broadcast",
          signatures: [{ signerHash: OWNER, bytes: new Uint8Array(65), signedAt: 1 }],
        },
      ],
    });
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Execute on Sepolia" }));
    await waitFor(() =>
      expect(usePendingTransactionsStore.getState().findById(PENDING.id)).toMatchObject({
        state: "confirming",
        broadcastedHash: `0x${"cd".repeat(32)}`,
      }),
    );
    expect(await screen.findByText("Confirming on Sepolia")).toBeInTheDocument();
  });

  it("resumes receipt polling and records confirmation", async () => {
    statusMock.mockResolvedValueOnce({
      state: "confirmed",
      blockNumber: 7_123_456n,
      confirmations: 1,
      confirmedAt: "2026-08-01T01:02:03.000Z",
      executorAddress: OWNER,
      gasUsed: 100_000n,
      effectiveGasPriceWei: 2_000_000_000n,
      gasFeeWei: 200_000_000_000_000n,
    });
    usePendingTransactionsStore.setState({
      transactions: [
        {
          ...PENDING,
          state: "confirming",
          broadcastedHash: `0x${"cd".repeat(32)}`,
        },
      ],
    });
    renderDetail();
    await waitFor(() =>
      expect(usePendingTransactionsStore.getState().findById(PENDING.id)).toMatchObject({
        state: "confirmed",
        confirmedBlockNumber: "7123456",
        executorAddress: OWNER,
        receiptGasUsed: "100000",
      }),
    );
    expect(await screen.findByText("Confirmed")).toBeInTheDocument();
  });

  it("shows a retry-safe accounting failure without offering chain execution", () => {
    usePendingTransactionsStore.setState({
      transactions: [{
        ...PENDING,
        state: "post_failed",
        broadcastedHash: `0x${"cd".repeat(32)}`,
        postError: "Frappe unavailable",
      }],
    });
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Frappe unavailable");
    expect(screen.queryByRole("button", { name: "Execute on Sepolia" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry accounting" }));
    expect(postAccountingMock).toHaveBeenCalledWith(PENDING.id);
  });
});

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/approvals/${PENDING.id}`]}>
        <Routes><Route path="/approvals/:id" element={<SafeApprovalDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
