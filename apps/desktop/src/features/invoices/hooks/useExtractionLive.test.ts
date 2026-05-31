// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExtractionLive } from "./useExtractionLive";
import { useInvoicesStore } from "@/stores/invoices";

const blank = (id: string) => ({
  id, createdAt: "t", updatedAt: "t", schema_version: "0.1.0" as const,
  intake: { source: "manual-upload" as const, received_at: "t", raw_file: { sha256: "0".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "s://x" } },
  invoice: { flow: "one-off-vendor" as const, payee: { kind: "vendor" as const, display_name: "" }, currency: "AUD", total: 0 },
  extraction: { pipeline: { stages: [] }, extracted_at: "t" },
  approval: { status: "draft" as const },
});

describe("useExtractionLive", () => {
  beforeEach(() => useInvoicesStore.setState({ invoices: [] }));

  it("returns current status and updates when store changes", () => {
    act(() => { useInvoicesStore.getState().addInvoice(blank("inv_1")); });
    const { result } = renderHook(() => useExtractionLive("inv_1"));
    expect(result.current.status).toBe("pending");
    act(() => { useInvoicesStore.getState().markExtractionRunning("inv_1"); });
    expect(result.current.status).toBe("running");
  });

  it("returns null status when invoice not found", () => {
    const { result } = renderHook(() => useExtractionLive("nope"));
    expect(result.current.status).toBeNull();
  });
});
