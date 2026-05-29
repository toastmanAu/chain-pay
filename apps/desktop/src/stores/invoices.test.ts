import { beforeEach, describe, expect, it } from "vitest";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoicesStore } from "./invoices";

function inv(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1",
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
    },
    invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "Acme" }, currency: "AUD", total: 100 },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "draft" },
    ...overrides,
  } as InvoiceRecord;
}

describe("useInvoicesStore", () => {
  beforeEach(() => {
    useInvoicesStore.setState({ invoices: [] });
    globalThis.localStorage?.clear();
  });

  it("addInvoice appends", () => {
    useInvoicesStore.getState().addInvoice(inv());
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
  });

  it("addInvoice is idempotent on duplicate id", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_42" }));
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_42", invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "DIFFERENT" }, currency: "USD", total: 999 } }));
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
    expect(useInvoicesStore.getState().findById("inv_42")?.invoice.payee.display_name).toBe("Acme");
  });

  it("markInReview transitions draft → in-review", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "draft" } }));
    useInvoicesStore.getState().markInReview("inv_1");
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });

  it("markInReview throws on illegal transition (signed → in-review)", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "signed" } }));
    expect(() => useInvoicesStore.getState().markInReview("inv_1")).toThrow(/invalid invoice transition/);
  });

  it("markInReview is idempotent on already-in-review (React Strict Mode safety)", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "draft" } }));
    useInvoicesStore.getState().markInReview("inv_1");
    // Second call must not throw — route effects double-fire under React Strict Mode.
    expect(() => useInvoicesStore.getState().markInReview("inv_1")).not.toThrow();
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });

  it("markQueuedForSigning records reviewer, timestamp, batchId", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "in-review" } }));
    useInvoicesStore.getState().markQueuedForSigning("inv_1", "batch_99", "user_42");
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("queued-for-signing");
    expect(after.approval.reviewed_by).toBe("user_42");
    expect(after.approval.reviewed_at).toBeDefined();
    expect(after.batchId).toBe("batch_99");
  });

  it("markSigned populates chainpay_link", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "queued-for-signing" } }));
    useInvoicesStore.getState().markSigned("inv_1", { txHash: "0xabc", chain: "ckb" });
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("signed");
    expect(after.chainpay_link?.tx_hash).toBe("0xabc");
    expect(after.chainpay_link?.chain).toBe("ckb");
  });

  it("markRejected records rejection_reason and transitions", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "in-review" } }));
    useInvoicesStore.getState().markRejected("inv_1", "duplicate of inv_42");
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("rejected");
    expect(after.approval.rejection_reason).toBe("duplicate of inv_42");
  });

  it("appendEdit pushes to edits_made", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1" }));
    useInvoicesStore.getState().appendEdit("inv_1", {
      field: "invoice.total", before: 100, after: 200, edited_by: "user_42",
    });
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.edits_made).toHaveLength(1);
    expect(after.approval.edits_made![0]?.field).toBe("invoice.total");
    expect(after.approval.edits_made![0]?.edited_at).toBeDefined();
  });

  it("filterByStatus returns matching invoices", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "a", approval: { status: "draft" } }));
    useInvoicesStore.getState().addInvoice(inv({ id: "b", approval: { status: "in-review" } }));
    useInvoicesStore.getState().addInvoice(inv({ id: "c", approval: { status: "in-review" } }));
    expect(useInvoicesStore.getState().filterByStatus("in-review")).toHaveLength(2);
  });
});
