import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { receiveMobileInvoice } from "./invoice-receiver";
import { persistMobileInvoice } from "./mobile-inbox-host";

vi.mock("./mobile-inbox-host", () => ({ persistMobileInvoice: vi.fn() }));
const sender = { send: vi.fn() };
const mockWebContents = sender as unknown as Electron.WebContents;
const payload = {
  id: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
  image_chunks: [Buffer.from("hello").toString("base64")],
  image_mime: "image/jpeg" as const,
};
const entry: Awaited<ReturnType<typeof persistMobileInvoice>>["entry"] = {
  invoiceId: `inv_${payload.id.toLowerCase()}`,
  mobileId: payload.id,
  capturedAt: payload.capturedAt,
  receivedAt: "2026-11-03T00:00:00.000Z",
  sourceLabel: "phone-1",
  extraction: payload.extraction,
  imageUri: "file:///tmp/test.jpg",
  imageSha256: "a".repeat(64),
  imageBytes: 5,
  imageMime: "image/jpeg",
};

beforeEach(() => {
  sender.send.mockReset();
  vi.mocked(persistMobileInvoice).mockReset();
});

describe("invoice-receiver", () => {
  it("notifies the renderer only after durable storage resolves", async () => {
    let finish!: (value: Awaited<ReturnType<typeof persistMobileInvoice>>) => void;
    vi.mocked(persistMobileInvoice).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    await Promise.resolve();
    expect(sender.send).not.toHaveBeenCalled();
    finish({ status: "created", entry });
    expect(await pending).toEqual({ status: "created", invoiceId: entry.invoiceId });
    expect(sender.send).toHaveBeenCalledWith("mobile-invoice:received", { invoiceId: entry.invoiceId });
  });

  it("returns a durable duplicate and nudges the renderer to reconcile again", async () => {
    vi.mocked(persistMobileInvoice).mockResolvedValue({ status: "duplicate", entry });
    const result = await receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    expect(result).toEqual({ status: "duplicate", invoiceId: entry.invoiceId });
    expect(sender.send).toHaveBeenCalledWith("mobile-invoice:received", { invoiceId: entry.invoiceId });
  });

  it("does not acknowledge an invoice when persistence fails", async () => {
    vi.mocked(persistMobileInvoice).mockRejectedValue(new Error("disk full"));
    await expect(receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents })).rejects.toThrow("disk full");
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects invalid payload schema", async () => {
    await expect(receiveMobileInvoice({ payload: { ...payload, id: "not-a-ulid" } as never, deviceLabel: "x", sendToRenderer: mockWebContents })).rejects.toThrow(/schema|invalid/i);
    expect(persistMobileInvoice).not.toHaveBeenCalled();
  });
});
