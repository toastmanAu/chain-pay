// @vitest-environment jsdom
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SolanaPaymentProposal, SolanaSignatureEnvelope, SolanaWatchTreasury } from "@chain-pay/shared";
import { CreateSolanaPayment } from "./CreateSolanaPayment";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";
import { useTreasuryStore } from "@/stores/treasury";

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const source = key(10);
const destination = key(11);
const nonceAccount = key(12);
const nonceAuthority = key(13);
const feePayer = key(14);
const durableNonce = key(15);
const signers = [feePayer, source, nonceAuthority];
const payment = { nonceAccount, nonceAuthority, feePayer };
const baseTreasury: SolanaWatchTreasury = {
  id: "sol-1",
  kind: "solana-watch",
  label: "SOL reserve",
  watch: { chain: "sol:devnet", address: source },
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};
const proposal: SolanaPaymentProposal = {
  version: 2,
  chain: "sol:devnet",
  treasuryId: "sol-1",
  source,
  destination,
  ...payment,
  sourceBalanceLamports: "1000000000",
  nonceBalanceLamports: "1500000",
  nonceRentMinimumLamports: "1447680",
  feePayerBalanceLamports: "100000",
  durableNonce,
  slot: "100",
  amountLamports: "10000000",
  feeLamports: "5000",
  messageBase64: "bWVzc2FnZQ==",
  unsignedTransactionBase64: "dHJhbnNhY3Rpb24=",
  requiredSigners: signers,
  reviewDigest: "a".repeat(64),
  createdAt: "2026-08-05T00:01:00.000Z",
  accounting: { payeeId: "vendor-sol", fiat: { currency: "USD", minor: "2550" } },
};

const paymentInspect = vi.fn();
const paymentPrepare = vi.fn();
const paymentValidateProposal = vi.fn();
const paymentSubmit = vi.fn();
const paymentVerifySignature = vi.fn();
const transactionStatus = vi.fn();

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [baseTreasury], activeTreasuryId: "sol-1" });
  useSolanaPaymentsStore.setState({ records: {} });
  paymentInspect.mockReset().mockResolvedValue({ inspection: proposal });
  paymentPrepare.mockReset().mockResolvedValue({ proposal });
  paymentValidateProposal.mockReset().mockImplementation(async ({ proposal: value }: { proposal: SolanaPaymentProposal }) => ({ proposal: value }));
  paymentSubmit.mockReset().mockResolvedValue({ receipt: { signature: "transaction-signature", reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:02:00.000Z", alreadySubmitted: false } });
  paymentVerifySignature.mockReset().mockImplementation(async ({ envelope }: { envelope: SolanaSignatureEnvelope }) => ({ envelope }));
  transactionStatus.mockReset().mockResolvedValue({ state: "confirmed", slot: "101", confirmations: 1 });
  (window as unknown as { chainpay: { solana: unknown } }).chainpay = {
    solana: { status: vi.fn(), scan: vi.fn(), transactionStatus, paymentInspect, paymentPrepare, paymentValidateProposal, paymentSubmit, paymentVerifySignature },
  };
});
afterEach(cleanup);

describe("CreateSolanaPayment", () => {
  it("validates and stores only public durable-nonce configuration", async () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText("Existing nonce account"), { target: { value: nonceAccount } });
    fireEvent.change(screen.getByLabelText("Decoded nonce authority"), { target: { value: nonceAuthority } });
    fireEvent.change(screen.getByLabelText("External fee payer"), { target: { value: feePayer } });
    fireEvent.click(screen.getByRole("button", { name: /validate and save/i }));
    await waitFor(() => expect(paymentInspect).toHaveBeenCalledWith({ chain: "sol:devnet", source, ...payment }));
    expect(useTreasuryStore.getState().treasuries[0]).toMatchObject({ payment });
    expect(JSON.stringify(useTreasuryStore.getState().treasuries)).not.toMatch(/seed|mnemonic|privateKey|secretKey/i);
  });

  it("shows immutable review and real signer order, then requires separate confirmation before broadcast", async () => {
    useTreasuryStore.setState({ treasuries: [{ ...baseTreasury, payment }], activeTreasuryId: "sol-1" });
    renderScreen();
    fireEvent.change(screen.getByLabelText("Destination wallet"), { target: { value: destination } });
    fireEvent.change(screen.getByLabelText("Amount (SOL)"), { target: { value: "0.01" } });
    fireEvent.change(screen.getByLabelText("Payee / accounting reference"), { target: { value: "vendor-sol" } });
    fireEvent.change(screen.getByLabelText("Accounting value"), { target: { value: "25.50" } });
    fireEvent.click(screen.getByRole("button", { name: /prepare immutable review/i }));
    expect(await screen.findByText("Immutable payment review")).toBeInTheDocument();
    expect(screen.getByText(/not a program-enforced M-of-N/i)).toBeInTheDocument();
    expect(screen.getByText("sol-1")).toBeInTheDocument();
    expect(screen.getByText(/AdvanceNonceAccount.*SystemProgram\.transfer/i)).toBeInTheDocument();
    expect(screen.getByText("USD 25.50")).toBeInTheDocument();
    expect(paymentPrepare).toHaveBeenCalledWith({ chain: "sol:devnet", treasuryId: "sol-1", source, destination, amountLamports: "10000000", accounting: proposal.accounting, ...payment });

    for (const signer of signers) {
      const envelope: SolanaSignatureEnvelope = { format: "chainpay-solana-signature-v2", chain: "sol:devnet", treasuryId: "sol-1", reviewDigest: proposal.reviewDigest, signer, signature: `signature-${signer}`, reviewSignature: `review-${signer}` };
      fireEvent.change(screen.getByLabelText("Signature envelope JSON"), { target: { value: JSON.stringify(envelope) } });
      fireEvent.click(screen.getByRole("button", { name: /verify and import/i }));
      await waitFor(() => expect(useSolanaPaymentsStore.getState().records["sol-1"]?.signatures).toHaveLength(signers.indexOf(signer) + 1));
    }
    expect(screen.getByRole("button", { name: /confirm and broadcast/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /confirm and broadcast/i }));
    expect(await screen.findByText("Submitted")).toBeInTheDocument();
    expect(paymentSubmit).toHaveBeenCalledWith(expect.objectContaining({ chain: "sol:devnet", treasuryId: "sol-1", proposal, signatures: expect.any(Array) }));
  });

  it("keeps a persisted legacy B2A review signable but explicitly excludes accounting", async () => {
    useTreasuryStore.setState({ treasuries: [{ ...baseTreasury, payment }], activeTreasuryId: "sol-1" });
    const { accounting: _accounting, ...legacy } = proposal;
    useSolanaPaymentsStore.getState().acceptProposal("sol-1", { ...legacy, version: 1 });
    renderScreen();
    expect(await screen.findByText(/legacy B2A review has no digest-bound accounting intent/i)).toBeInTheDocument();
    expect(useSolanaPaymentsStore.getState().records["sol-1"]?.accountingState).toBe("not_applicable");
  });

  it("shows finalized accounting identities, retry, and a prominent regression warning", async () => {
    useTreasuryStore.setState({ treasuries: [{ ...baseTreasury, payment }], activeTreasuryId: "sol-1" });
    const receipt = { signature: "transaction-signature", reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:02:00.000Z", alreadySubmitted: false };
    const evidence = { version: 1 as const, chain: proposal.chain, reviewDigest: proposal.reviewDigest, signature: receipt.signature,
      slot: "102", finalizedAt: "2026-08-05T00:03:00.000Z", transactionVersion: "legacy" as const,
      messageBase64: proposal.messageBase64, signedTransactionBase64: "c2lnbmVk", source: proposal.source,
      destination: proposal.destination, amountLamports: proposal.amountLamports, feePayer: proposal.feePayer,
      feeLamports: proposal.feeLamports, feePayerPolicy: "transaction_fee_payer" as const,
      nonceAccount: proposal.nonceAccount, nonceAuthority: proposal.nonceAuthority, durableNonce: proposal.durableNonce };
    useSolanaPaymentsStore.setState({ records: { "sol-1": {
      treasuryId: "sol-1", state: "submitted", proposal, signatures: [], receipt, transactionState: "finalized",
      rollbackDetected: false, accountingState: "posted", finalizedEvidence: evidence,
      accountingRecordName: "BATCH-SOL-1", journalEntryName: "JE-SOL-1", accountingError: null,
      reconciliationRequired: false, error: null, updatedAt: evidence.finalizedAt,
    } } });
    transactionStatus.mockResolvedValue({ state: "finalized", slot: "102", confirmations: null });
    renderScreen();
    expect(await screen.findByText("Accounting posted")).toBeInTheDocument();
    expect(screen.getByText(/Source record: BATCH-SOL-1/)).toBeInTheDocument();
    expect(screen.getByText(/Journal Entry: JE-SOL-1/)).toBeInTheDocument();

    act(() => useSolanaPaymentsStore.getState().updateTransactionState("sol-1", "unknown"));
    expect(await screen.findByText("Accounting reconciliation required")).toBeInTheDocument();
    expect(screen.getByText(/will not reverse, rebroadcast, or post automatically/i)).toBeInTheDocument();

    useSolanaPaymentsStore.setState({ records: { "sol-1": { ...useSolanaPaymentsStore.getState().records["sol-1"]!, transactionState: "finalized", rollbackDetected: false, reconciliationRequired: false, accountingState: "post_failed", accountingError: "backend unavailable" } } });
    expect(await screen.findByRole("button", { name: "Retry accounting post" })).toBeInTheDocument();
  });
});

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/treasury/sol-1/solana/payment/new"]}>
        <Routes><Route path="/treasury/:treasuryId/solana/payment/new" element={<CreateSolanaPayment />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
