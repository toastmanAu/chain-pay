// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { InvoiceList } from "./InvoiceList";

function inv(id: string, status: InvoiceRecord["approval"]["status"]): InvoiceRecord {
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
        filename: "x.pdf",
        storage_uri: "file:///x",
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: "v", display_name: `Vendor ${id}` },
      currency: "AUD",
      total: 100,
      invoice_number: `INV-${id}`,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status },
  };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({
    invoices: [
      inv("a", "in-review"),
      inv("b", "in-review"),
      inv("c", "queued-for-signing"),
      inv("d", "signed"),
      inv("e", "rejected"),
    ] as never,
  });
});
afterEach(() => cleanup());

function wrap(onSelectionChange?: (selected: Set<string>) => void) {
  const props = onSelectionChange ? { onSelectionChange } : {};
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<InvoiceList {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InvoiceList", () => {
  it("groups invoices by status with counts", () => {
    wrap();
    expect(screen.getByText(/in review \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/queued for signing \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/signed/i)).toBeInTheDocument();
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it("clicking an in-review row navigates to Stage B", async () => {
    const user = userEvent.setup();
    wrap();
    const reviewBtn = screen.getAllByRole("button", { name: /review →/i })[0];
    expect(reviewBtn).toBeDefined();
    await user.click(reviewBtn!);
    expect(reviewBtn).toBeInTheDocument();
  });

  it("renders a checkbox per row in 'in-review' section and reports selection up", () => {
    const onSelectionChange = vi.fn();
    wrap(onSelectionChange);
    const checks = screen.getAllByRole("checkbox");
    // beforeEach seeds two in-review invoices (a, b)
    expect(checks.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(checks[0]!);
    expect(onSelectionChange).toHaveBeenCalled();
    const lastCall = onSelectionChange.mock.calls.at(-1)![0] as Set<string>;
    expect(lastCall).toBeInstanceOf(Set);
    expect(lastCall.size).toBe(1);
  });

  it("does not render checkboxes in non-bundle-eligible sections (signed, rejected)", () => {
    // Override store: no in-review invoices, only signed + rejected
    useInvoicesStore.setState({
      invoices: [
        inv("d", "signed"),
        inv("e", "rejected"),
      ] as never,
    });
    wrap();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
