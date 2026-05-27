// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInvoiceDraftsStore } from "@/stores/invoice-drafts";
import { useInvoiceDraft } from "./useInvoiceDraft";

beforeEach(() => {
  useInvoiceDraftsStore.setState({ drafts: {} });
  globalThis.localStorage?.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useInvoiceDraft", () => {
  it("returns the persisted draft on mount if present", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", {
      invoice: {
        flow: "one-off-vendor",
        payee: { kind: "vendor", display_name: "Saved" },
        currency: "AUD",
        total: 99,
      },
    } as never);
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    expect(result.current.draft?.invoice?.payee?.display_name).toBe("Saved");
  });

  it("debounces writes by 500ms", () => {
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    act(() => {
      result.current.update({
        invoice: {
          flow: "one-off-vendor",
          payee: { kind: "vendor", display_name: "A" },
          currency: "AUD",
          total: 1,
        },
      } as never);
      result.current.update({
        invoice: {
          flow: "one-off-vendor",
          payee: { kind: "vendor", display_name: "B" },
          currency: "AUD",
          total: 2,
        },
      } as never);
      result.current.update({
        invoice: {
          flow: "one-off-vendor",
          payee: { kind: "vendor", display_name: "C" },
          currency: "AUD",
          total: 3,
        },
      } as never);
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")?.invoice?.payee?.display_name).toBe(
      "C",
    );
  });

  it("clear() removes the draft immediately", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", {
      invoice: {
        flow: "one-off-vendor",
        payee: { kind: "vendor", display_name: "X" },
        currency: "AUD",
        total: 1,
      },
    } as never);
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    act(() => {
      result.current.clear();
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
  });
});
