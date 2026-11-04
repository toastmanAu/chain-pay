// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileInboxEntry } from "../../../electron/main/mobile-inbox-host";
import { useInvoicesStore } from "@/stores/invoices";
import { importMobileInbox } from "./use-mobile-inbox";

const entry: MobileInboxEntry = {
  invoiceId: "inv_01hxyzabcdefghjkmnpqrstvwx",
  mobileId: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  receivedAt: "2026-11-03T00:00:00.000Z",
  sourceLabel: "a53-smoke",
  extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
  imageUri: "file:///tmp/test.jpg",
  imageSha256: "a".repeat(64),
  imageBytes: 10,
  imageMime: "image/jpeg",
};

beforeEach(() => {
  useInvoicesStore.setState({ invoices: [] });
  globalThis.localStorage.clear();
  (window as unknown as { chainpay: unknown }).chainpay = {
    pair: { listMobileInbox: vi.fn(async () => [entry]) },
  };
});

describe("mobile inbox reconciliation", () => {
  it("imports a stored entry once as an extracted, visible review invoice", async () => {
    expect(await importMobileInbox()).toBe(1);
    expect(await importMobileInbox()).toBe(0);
    const records = useInvoicesStore.getState().invoices;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: entry.invoiceId,
      extractionStatus: "extracted",
      approval: { status: "in-review" },
      intake: { raw_file: { mime_type: "image/jpeg" } },
    });
  });
});
