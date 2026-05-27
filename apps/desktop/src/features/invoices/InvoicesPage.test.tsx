// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvoicesPage } from "./InvoicesPage";

// Mock pdfjs so ReviewInvoiceForm sub-route doesn't crash if it ever renders
vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ render: () => ({ promise: Promise.resolve() }) }) }) }),
  GlobalWorkerOptions: { workerSrc: "" },
}));

afterEach(() => cleanup());

describe("InvoicesPage", () => {
  it("renders the header and New invoice button", () => {
    render(
      <MemoryRouter initialEntries={["/invoices"]}>
        <Routes>
          <Route path="/invoices/*" element={<InvoicesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /^invoices$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+ new invoice/i })).toBeInTheDocument();
  });

  it("clicking + New invoice navigates to /invoices/new", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/invoices"]}>
        <Routes>
          <Route path="/invoices/*" element={<InvoicesPage />} />
        </Routes>
      </MemoryRouter>,
    );
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
});
