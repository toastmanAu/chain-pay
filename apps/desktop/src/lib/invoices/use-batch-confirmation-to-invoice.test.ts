import { beforeEach, describe, expect, it } from "vitest";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { syncBatchConfirmedToInvoice } from "./use-batch-confirmation-to-invoice";

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({ invoices: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
});

describe("syncBatchConfirmedToInvoice", () => {
  it("transitions linked invoice to signed when batch reaches confirmed", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "queued-for-signing" },
        batchId: "vb_1",
      }] as never,
    });
    usePayrollBatchesStore.setState({
      batches: [{ kind: "vendor", id: "vb_1", state: "confirmed", pendingTxId: "0xdeadbeef", createdAt: now, updatedAt: now, label: "", treasuryId: "", invoiceId: "inv_1", vendorId: "v_1", fxSnapshot: [], line: { vendorId: "v_1", fiat: { minor: 100n, currency: "AUD" }, crypto: { value: 0n, asset: "CKB", decimals: 8 }, fxRate: "0", feeAllocated: { value: 0n, asset: "CKB", decimals: 8 } } }] as never,
      selectedDraftId: null,
    });

    syncBatchConfirmedToInvoice();

    const inv = useInvoicesStore.getState().findById("inv_1")!;
    expect(inv.approval.status).toBe("signed");
    expect(inv.chainpay_link?.tx_hash).toBe("0xdeadbeef");
    expect(inv.chainpay_link?.chain).toBe("ckb");
  });

  it("does nothing when no batches are in confirmed state", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "queued-for-signing" },
        batchId: "vb_1",
      }] as never,
    });
    syncBatchConfirmedToInvoice();
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("queued-for-signing");
  });

  it("is idempotent — running twice doesn't re-transition or duplicate edits", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "signed" },
        chainpay_link: { tx_hash: "0xdead", chain: "ckb" },
        batchId: "vb_1",
      }] as never,
    });
    usePayrollBatchesStore.setState({
      batches: [{ kind: "vendor", id: "vb_1", state: "confirmed", pendingTxId: "0xdead", createdAt: now, updatedAt: now, label: "", treasuryId: "", invoiceId: "inv_1", vendorId: "v_1", fxSnapshot: [], line: { vendorId: "v_1", fiat: { minor: 100n, currency: "AUD" }, crypto: { value: 0n, asset: "CKB", decimals: 8 }, fxRate: "0", feeAllocated: { value: 0n, asset: "CKB", decimals: 8 } } }] as never,
      selectedDraftId: null,
    });
    syncBatchConfirmedToInvoice();
    syncBatchConfirmedToInvoice();
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("signed");
  });
});
