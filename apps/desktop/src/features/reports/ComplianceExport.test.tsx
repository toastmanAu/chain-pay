// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComplianceExport, complianceExportError } from "./ComplianceExport";

const requestExport = vi.fn();

describe("ComplianceExport", () => {
  beforeEach(() => requestExport.mockReset());
  afterEach(cleanup);

  it("requests a filtered CSV and reports the saved evidence digest", async () => {
    requestExport.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/chainpay-compliance.csv",
      rowCount: 2,
      sha256: "ab".repeat(32),
    });
    render(<ComplianceExport requestExport={requestExport} />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-07-31" } });
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "ckb:testnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => expect(requestExport).toHaveBeenCalledWith({
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
      chain: "ckb:testnet",
    }, "csv"));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved 2 payment lines");
    expect(screen.getByRole("status")).toHaveTextContent("abab");
  });

  it("offers PDF, handles cancellation silently, and remains usable after remount", async () => {
    requestExport.mockResolvedValueOnce({ canceled: true });
    const first = render(<ComplianceExport requestExport={requestExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Export printable PDF" }));
    await waitFor(() => expect(requestExport).toHaveBeenCalledWith({}, "pdf"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    first.unmount();

    requestExport.mockResolvedValueOnce({
      canceled: false, filePath: "/tmp/report.pdf", rowCount: 1, sha256: "cd".repeat(32),
    });
    render(<ComplianceExport requestExport={requestExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Export printable PDF" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved 1 payment line");
  });

  it("shows local date validation", () => {
    render(<ComplianceExport requestExport={requestExport} />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-02" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be after");
    expect(requestExport).not.toHaveBeenCalled();
  });

  it("preserves actionable backend errors and safely maps unknown failures", () => {
    expect(complianceExportError(new Error("no submitted confirmed payments match the compliance filters")))
      .toBe("no submitted confirmed payments match the compliance filters");
    expect(complianceExportError({ secret: "must not stringify" })).toBe("Compliance export failed.");
  });
});
