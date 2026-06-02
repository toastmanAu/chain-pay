// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { useInvoicesStore, type StoredInvoiceRecord } from "@/stores/invoices";
import { useInvoiceDraftsStore } from "@/stores/invoice-drafts";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useTreasuryStore } from "@/stores/treasury";
import { ReviewInvoiceForm } from "./ReviewInvoiceForm";

// ---------------------------------------------------------------------------
// Extraction service mock — hoisted so vi.mock factory can capture enqueueMock
// ---------------------------------------------------------------------------
const enqueueMock = vi.fn();
vi.mock("@/lib/invoices/extraction", () => ({
  extractionService: () => ({ enqueue: enqueueMock }),
}));

// fileFromStorage mock — returns a dummy Blob so the Retry path works without IPC
vi.mock("@/lib/invoices/file-storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/invoices/file-storage")>();
  return {
    ...original,
    fileFromStorage: vi.fn().mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" })),
  };
});

vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          render: () => ({ promise: Promise.resolve() }),
        }),
    }),
  }),
  GlobalWorkerOptions: { workerSrc: "" },
}));

function invoiceFixture(): StoredInvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1",
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: {
        sha256: "a".repeat(64),
        mime_type: "application/pdf",
        byte_size: 100,
        filename: "test.pdf",
        storage_uri: "file:///fake/test.pdf",
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: "v_1", display_name: "Acme" },
      currency: "AUD",
      total: 0,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "draft" },
    extractionStatus: "pending",
  };
}

function treasuryFixture(): Treasury {
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

beforeEach(() => {
  globalThis.localStorage?.clear();
  enqueueMock.mockClear();
  useInvoicesStore.setState({ invoices: [invoiceFixture()] });
  useInvoiceDraftsStore.setState({ drafts: {} });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  useTreasuryStore.setState({
    treasuries: [treasuryFixture()],
    activeTreasuryId: "tr_1",
  });
});

afterEach(() => cleanup());

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/invoices/inv_1/review"]}>
      <Routes>
        <Route path="/invoices/:id/review" element={<ReviewInvoiceForm />} />
        <Route path="/payments" element={<div>PAY PANEL</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReviewInvoiceForm — extraction states", () => {
  it("shows 'Extracting…' banner while running and form remains editable", () => {
    useInvoicesStore.setState({
      invoices: [{ ...invoiceFixture(), extractionStatus: "running" }],
    });
    renderWithRouter();
    expect(screen.getByText(/Extracting…/)).toBeInTheDocument();
    // Form must remain editable — vendor input is not disabled
    expect(screen.getByDisplayValue("Acme")).not.toBeDisabled();
  });

  it("shows amber chip on fields with confidence < 0.85", () => {
    const inv = invoiceFixture();
    // Inject field_confidences into the extraction record
    const invWithConfidences: StoredInvoiceRecord = {
      ...inv,
      extractionStatus: "extracted",
      extraction: {
        ...inv.extraction,
        field_confidences: {
          total: 0.5,          // below threshold → chip expected
          invoice_number: 0.9, // above threshold → no chip
        },
      },
    };
    useInvoicesStore.setState({ invoices: [invWithConfidences] });
    renderWithRouter();
    // Low-confidence chip for 'total'
    const chips = screen.getAllByText(/Low confidence — please check/i);
    expect(chips.length).toBeGreaterThanOrEqual(1);
    // Find the label containing "Total" chip by finding all labels, then the one
    // whose text starts with "Total"
    const allLabels = document.querySelectorAll("label");
    const totalLabel = Array.from(allLabels).find(
      (l) => l.textContent?.trim().startsWith("Total"),
    );
    expect(totalLabel).toBeDefined();
    expect(totalLabel).toHaveTextContent(/Low confidence — please check/i);
    // Invoice number label should NOT have a chip
    const invNumLabel = Array.from(allLabels).find((l) =>
      l.textContent?.trim().startsWith("Invoice #"),
    );
    expect(invNumLabel).toBeDefined();
    expect(invNumLabel).not.toHaveTextContent(/Low confidence — please check/i);
  });

  it("shows 'Auto-extraction failed' banner with Retry on failed", async () => {
    const user = userEvent.setup();
    useInvoicesStore.setState({
      invoices: [
        {
          ...invoiceFixture(),
          extractionStatus: "failed",
          extractionError: "WASM init failed",
        },
      ],
    });
    renderWithRouter();
    // Banner present
    expect(screen.getByText(/Auto-extraction failed/i)).toBeInTheDocument();
    expect(screen.getByText(/WASM init failed/i)).toBeInTheDocument();
    // Click Retry
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(enqueueMock).toHaveBeenCalledWith("inv_1", expect.any(Blob));
  });
});

describe("ReviewInvoiceForm (Stage B)", () => {
  it("renders the invoice fields pre-populated", () => {
    renderWithRouter();
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("AUD")).toBeInTheDocument();
  });

  it("editing total + Approve triggers approveAndQueue and appends edits_made", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const totalInput = screen.getByLabelText(/^total$/i);
    await user.clear(totalInput);
    await user.type(totalInput, "100");
    await user.click(screen.getByRole("button", { name: /approve.*queue/i }));
    const after = useInvoicesStore.getState().findById("inv_1");
    expect(after).toBeDefined();
    expect(after?.approval.status).toBe("queued-for-signing");
    expect(after?.approval.edits_made?.some((e) => e.field === "invoice.total")).toBe(true);
    expect(await screen.findByText(/PAY PANEL/)).toBeInTheDocument();
  });

  it("Reject captures rejection reason and transitions", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    await user.type(screen.getByLabelText(/rejection reason/i), "dup");
    await user.click(screen.getByRole("button", { name: /confirm reject/i }));
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("rejected");
  });

  it("blocks Approve when Zod validation fails (e.g. total = 0)", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole("button", { name: /approve.*queue/i }));
    expect(screen.getByText(/total.*required/i)).toBeInTheDocument();
    // Component auto-transitions draft→in-review on mount; the assertion here
    // is that Approve is blocked (i.e. NOT queued-for-signing).
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });
});
