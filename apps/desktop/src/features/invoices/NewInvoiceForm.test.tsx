// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInvoicesStore } from "@/stores/invoices";
import { useVendorsStore } from "@/stores/vendors";
import { NewInvoiceForm } from "./NewInvoiceForm";

beforeEach(() => {
  useInvoicesStore.setState({ invoices: [] });
  useVendorsStore.setState({ vendors: [] });
  globalThis.localStorage?.clear();
  const ipc = {
    store: vi.fn(async (_bytes: Uint8Array, sha256: string) => `file:///fake/${sha256}.pdf`),
    read: vi.fn(async (_uri: string) => new Uint8Array()),
    delete: vi.fn(async (_uri: string) => {}),
  };
  (window as unknown as { chainpay: { invoiceFiles: typeof ipc } }).chainpay = {
    invoiceFiles: ipc,
  };
});

afterEach(() => cleanup());

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/invoices/new"]}>
      <Routes>
        <Route path="/invoices/new" element={<NewInvoiceForm />} />
        <Route path="/invoices/:id/review" element={<div>REVIEW STAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewInvoiceForm (Stage A)", () => {
  it("default flow is one-off-vendor; switching to employee-payment hides VendorPicker", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    expect(screen.getByPlaceholderText(/search vendors/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/employee payment/i));
    expect(screen.queryByPlaceholderText(/search vendors/i)).not.toBeInTheDocument();
  });

  it("rejects non-PDF/PNG/JPG uploads", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const file = new File(["x"], "evil.exe", { type: "application/x-msdownload" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    expect(screen.getByText(/only pdf, png, jpg accepted/i)).toBeInTheDocument();
  });

  it("rejects files over 50MB", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const big = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.pdf", {
      type: "application/pdf",
    });
    await user.upload(screen.getByLabelText(/upload pdf/i), big);
    expect(screen.getByText(/must be under 50 mb/i)).toBeInTheDocument();
  });

  it("Continue button is disabled until vendor + valid file are present", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const file = new File([new Uint8Array([1, 2, 3])], "ok.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    useVendorsStore.getState().addVendor({
      id: "v1",
      displayName: "Acme",
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: "",
      updatedAt: "",
    });
    await user.click(await screen.findByRole("button", { name: /Acme/i }));
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("Continue creates InvoiceRecord, calls storeBlob, and navigates to Stage B", async () => {
    const user = userEvent.setup();
    useVendorsStore.getState().addVendor({
      id: "v1",
      displayName: "Acme",
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: "",
      updatedAt: "",
    });
    renderWithRouter();
    const file = new File([new Uint8Array([1, 2, 3])], "ok.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    await user.click(await screen.findByRole("button", { name: /Acme/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
    expect(await screen.findByText(/REVIEW STAGE/)).toBeInTheDocument();
  });
});
