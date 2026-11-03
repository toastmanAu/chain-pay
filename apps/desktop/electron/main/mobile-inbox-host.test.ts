import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInvoiceFile, __resetForTest as resetInvoiceFiles } from "./invoice-files-host";
import { listMobileInbox, persistMobileInvoice, __resetMobileInboxForTest } from "./mobile-inbox-host";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => "/unused" } }));

const payload = {
  id: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
  image_chunks: [Buffer.from("test image").toString("base64")],
  image_mime: "image/jpeg" as const,
};
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chainpay-mobile-inbox-"));
  resetInvoiceFiles(root);
  __resetMobileInboxForTest(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("mobile inbox", () => {
  it("stores the image and metadata before reporting created, then survives a new read", async () => {
    const first = await persistMobileInvoice(payload, "a53-smoke");
    expect(first.status).toBe("created");
    expect(first.entry.invoiceId).toBe(`inv_${payload.id.toLowerCase()}`);
    expect(first.entry.imageMime).toBe("image/jpeg");
    expect(Buffer.from(await readInvoiceFile(first.entry.imageUri)).toString()).toBe("test image");
    expect(await listMobileInbox()).toEqual([first.entry]);
  });

  it("returns the first stored invoice on a duplicate mobile ID", async () => {
    const first = await persistMobileInvoice(payload, "a53-smoke");
    const duplicate = await persistMobileInvoice({ ...payload, image_chunks: [Buffer.from("changed").toString("base64")] }, "other-device");
    expect(duplicate).toEqual({ status: "duplicate", entry: first.entry });
    expect(await listMobileInbox()).toHaveLength(1);
  });

  it("rejects an empty image before acknowledging it", async () => {
    await expect(persistMobileInvoice({ ...payload, image_chunks: [] }, "a53-smoke")).rejects.toThrow(/empty image/i);
    expect(await listMobileInbox()).toEqual([]);
  });
});
