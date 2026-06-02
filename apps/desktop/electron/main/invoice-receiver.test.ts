import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { receiveMobileInvoice, _resetSeenIdsForTests } from "./invoice-receiver";

const sender = { send: vi.fn() };
const mockWebContents = sender as unknown as Electron.WebContents;

beforeEach(() => {
  sender.send.mockReset();
  _resetSeenIdsForTests();
});

const payload = {
  id: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
  image_chunks: [Buffer.from("hello").toString("base64")],
  image_mime: "image/jpeg" as const,
};

describe("invoice-receiver", () => {
  it("dispatches via IPC and returns 'created' on first id", async () => {
    const out = await receiveMobileInvoice({
      payload,
      deviceLabel: "phone-1",
      sendToRenderer: mockWebContents,
    });
    expect(out.status).toBe("created");
    expect(out.invoiceId).toMatch(/^inv_/);
    expect(sender.send).toHaveBeenCalledWith(
      "mobile-invoice:received",
      expect.objectContaining({ invoiceId: out.invoiceId, sourceLabel: "phone-1" }),
    );
  });

  it("returns 'duplicate' with same invoiceId on repeated id", async () => {
    const first = await receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    const second = await receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    expect(second.status).toBe("duplicate");
    expect(second.invoiceId).toBe(first.invoiceId);
  });

  it("rejects invalid payload schema", async () => {
    await expect(
      receiveMobileInvoice({
        payload: { ...payload, id: "not-a-ulid" } as never,
        deviceLabel: "x",
        sendToRenderer: mockWebContents,
      }),
    ).rejects.toThrow(/schema|invalid/i);
  });
});
