// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Treasury } from "@chain-pay/shared";
import { useInvoicesStore, type StoredInvoiceRecord } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useTreasuryStore } from "@/stores/treasury";
import { InvoicesPage } from "./InvoicesPage";

// Mock pdfjs so ReviewInvoiceForm sub-route doesn't crash if it ever renders
vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ render: () => ({ promise: Promise.resolve() }) }) }) }),
  GlobalWorkerOptions: { workerSrc: "" },
}));

// Mock react-router-dom's useNavigate so we can spy on navigation
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function eligibleInvoice(id: string, currency = "AUD"): StoredInvoiceRecord {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: {
        sha256: "a".repeat(64),
        mime_type: "application/pdf",
        byte_size: 1,
        filename: `${id}.pdf`,
        storage_uri: `file:///${id}`,
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: `vendor_${id}`, display_name: `Vendor ${id}` },
      currency,
      total: 100,
      payment_details: { ckb_address: `ckt1${id}` },
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
    extractionStatus: "extracted",
  };
}

function testTreasury(): Treasury {
  return {
    id: "tr_1",
    label: "Test Treasury",
    createdAt: "2026-05-27T00:00:00Z",
    updatedAt: "2026-05-27T00:00:00Z",
    multisig: {
      chain: "ckb:testnet",
      s: 0,
      r: 0,
      m: 2,
      n: 3,
      pubkeyHashes: [
        "0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908",
        "0x0463eacbe31265f36f1ac23d26b28755ed34a767",
        "0xe4d15db3846f6ecd38b760298419450b21391e73",
      ],
      address: "ckt1qtestnet",
    },
  };
}

function renderInvoicesIndex() {
  return render(
    <MemoryRouter initialEntries={["/invoices"]}>
      <Routes>
        <Route path="/invoices/*" element={<InvoicesPage />} />
        <Route path="/payments/:id" element={<div data-testid="pay-panel">Pay Panel</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  mockNavigate.mockClear();
  useInvoicesStore.setState({ invoices: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  useTreasuryStore.setState({ treasuries: [testTreasury()], activeTreasuryId: "tr_1" });
});

afterEach(() => cleanup());

describe("InvoicesPage", () => {
  it("renders the header and New invoice button", () => {
    renderInvoicesIndex();
    expect(screen.getByRole("heading", { name: /^invoices$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+ new invoice/i })).toBeInTheDocument();
  });

  it("clicking + New invoice navigates to /invoices/new", async () => {
    const user = userEvent.setup();
    renderInvoicesIndex();
    // Mock window.chainpay.invoiceFiles (needed if NewInvoiceForm fully renders)
    const ipc = {
      store: vi.fn(async (_bytes: Uint8Array, sha256: string) => `file:///fake/${sha256}.pdf`),
      read: vi.fn(async (_uri: string) => new Uint8Array()),
      delete: vi.fn(async (_uri: string) => {}),
    };
    (window as unknown as { chainpay: { invoiceFiles: typeof ipc } }).chainpay = {
      invoiceFiles: ipc,
    };
    await user.click(screen.getByRole("link", { name: /\+ new invoice/i }));
    expect(await screen.findByRole("heading", { name: /^new invoice$/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Bundle toolbar tests
  // ---------------------------------------------------------------------------

  it("no bundle CTA when fewer than 2 invoices selected", async () => {
    useInvoicesStore.setState({ invoices: [eligibleInvoice("a"), eligibleInvoice("b")] as never });
    const user = userEvent.setup();
    renderInvoicesIndex();

    // no selection yet — CTA must not be visible
    expect(screen.queryByRole("button", { name: /bundle into batch/i })).not.toBeInTheDocument();

    // tick only one checkbox
    const [firstCheckbox] = screen.getAllByRole("checkbox");
    await user.click(firstCheckbox!);
    expect(screen.queryByRole("button", { name: /bundle into batch/i })).not.toBeInTheDocument();
  });

  it("shows 'Bundle into batch (N)' CTA when ≥2 in-review eligible invoices selected", async () => {
    useInvoicesStore.setState({ invoices: [eligibleInvoice("a"), eligibleInvoice("b")] as never });
    const user = userEvent.setup();
    renderInvoicesIndex();

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);

    const cta = screen.getByRole("button", { name: /bundle into batch \(2\)/i });
    expect(cta).toBeInTheDocument();
    expect(cta).not.toBeDisabled();
  });

  it("CTA is disabled with currency-mismatch tooltip when selection has mixed currencies", async () => {
    useInvoicesStore.setState({
      invoices: [eligibleInvoice("a", "AUD"), eligibleInvoice("b", "USD")] as never,
    });
    const user = userEvent.setup();
    renderInvoicesIndex();

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);

    const cta = screen.getByRole("button", { name: /bundle into batch \(2\)/i });
    expect(cta).toBeDisabled();
    expect(cta.getAttribute("title")).toMatch(/currency/i);
  });

  it("clicking Bundle creates one VendorPaymentBatch, marks invoices queued, and navigates", async () => {
    useInvoicesStore.setState({ invoices: [eligibleInvoice("a"), eligibleInvoice("b")] as never });
    const addBatchSpy = vi.spyOn(usePayrollBatchesStore.getState(), "addBatch");
    const markQueuedSpy = vi.spyOn(useInvoicesStore.getState(), "markQueuedForSigning");

    const user = userEvent.setup();
    renderInvoicesIndex();

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);

    const cta = screen.getByRole("button", { name: /bundle into batch \(2\)/i });
    await user.click(cta);

    // batch persisted once with both invoiceIds
    expect(addBatchSpy).toHaveBeenCalledOnce();
    const addedBatch = addBatchSpy.mock.calls[0]![0] as { invoiceIds: string[]; id: string };
    expect(addedBatch.invoiceIds).toHaveLength(2);
    expect(addedBatch.invoiceIds).toContain("a");
    expect(addedBatch.invoiceIds).toContain("b");

    // each invoice marked queued with the same batchId
    expect(markQueuedSpy).toHaveBeenCalledTimes(2);
    const batchId = addedBatch.id;
    expect(markQueuedSpy).toHaveBeenCalledWith("a", batchId, "operator");
    expect(markQueuedSpy).toHaveBeenCalledWith("b", batchId, "operator");

    // navigation fired
    expect(mockNavigate).toHaveBeenCalledWith(`/payments/${batchId}`);
  });
});
