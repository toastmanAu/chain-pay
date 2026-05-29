import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { approveAndQueue } from "./approve-and-queue";

function inv(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  const base: InvoiceRecord = {
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
        byte_size: 1,
        filename: "x.pdf",
        storage_uri: "file:///x",
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: "vendor_1", display_name: "Acme" },
      currency: "AUD",
      total: 100,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
  };
  return {
    ...base,
    ...overrides,
    invoice: { ...base.invoice, ...(overrides.invoice ?? {}) },
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

const treasury = treasuryFixture();

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({ invoices: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
});

describe("approveAndQueue", () => {
  it("writes the batch then transitions the invoice (happy path)", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const result = approveAndQueue(inv(), treasury, "user_42");
    expect(result.batchId).toMatch(/^vb_/);
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(1);
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe(
      "queued-for-signing",
    );
    expect(useInvoicesStore.getState().findById("inv_1")?.batchId).toBe(result.batchId);
  });

  it("writes the batch FIRST — if invoice update throws, batch remains but invoice stays in in-review", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const markSpy = vi
      .spyOn(useInvoicesStore.getState(), "markQueuedForSigning")
      .mockImplementation(() => {
        throw new Error("simulated localStorage quota");
      });

    expect(() => approveAndQueue(inv(), treasury, "user_42")).toThrow(
      /simulated localStorage quota/,
    );

    expect(usePayrollBatchesStore.getState().batches).toHaveLength(1);
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");

    markSpy.mockRestore();
  });

  it("throws on missing treasury (caller passes null)", () => {
    useInvoicesStore.getState().addInvoice(inv());
    expect(() =>
      approveAndQueue(inv(), null as unknown as Treasury, "user_42"),
    ).toThrow(/treasury required/i);
  });

  it("throws if invoice routing fails (e.g. unsupported flow)", () => {
    const badInv = inv({
      invoice: {
        flow: "unknown",
        payee: { kind: "unknown", id: "vendor_1", display_name: "Acme" },
        currency: "AUD",
        total: 100,
      } as InvoiceRecord["invoice"],
    });
    useInvoicesStore.getState().addInvoice(badInv);
    expect(() => approveAndQueue(badInv, treasury, "user_42")).toThrow(/unsupported flow/i);
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(0);
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });

  it("re-calling on the same invoice creates two distinct batches but the second transition is blocked by the state machine", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const r1 = approveAndQueue(inv(), treasury, "user_42");
    // Roll the invoice back to in-review for the second call
    useInvoicesStore.setState((s) => ({
      invoices: s.invoices.map((i) =>
        i.id === "inv_1" ? { ...i, approval: { ...i.approval, status: "in-review" } } : i,
      ),
    }));
    const r2 = approveAndQueue(inv(), treasury, "user_42");
    expect(r2.batchId).not.toBe(r1.batchId);
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(2);
  });
});
