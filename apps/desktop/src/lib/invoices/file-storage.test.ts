import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashBlob, storeBlob, readUri, deleteUri } from "./file-storage";

beforeEach(() => {
  const ipc = {
    store: vi.fn(async (_bytes: Uint8Array, sha256: string) => `file:///fake/${sha256}.pdf`),
    read: vi.fn(async (_uri: string) => new Uint8Array([7, 8, 9])),
    delete: vi.fn(async (_uri: string) => {}),
  };
  (globalThis as unknown as { window: { chainpay: { invoiceFiles: typeof ipc } } }).window = {
    chainpay: { invoiceFiles: ipc },
  };
});

describe("file-storage", () => {
  it("hashBlob returns 64-char hex sha256", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const hash = await hashBlob(blob);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashBlob is deterministic", async () => {
    const a = await hashBlob(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await hashBlob(new Blob([new Uint8Array([1, 2, 3])]));
    expect(a).toBe(b);
  });

  it("storeBlob hashes then invokes IPC store with bytes + sha256", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const { uri, sha256 } = await storeBlob(blob);
    expect(uri).toBe(`file:///fake/${sha256}.pdf`);
  });

  it("readUri delegates to IPC", async () => {
    const bytes = await readUri("file:///fake/x.pdf");
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it("deleteUri delegates to IPC", async () => {
    await deleteUri("file:///fake/x.pdf");
    expect(window.chainpay.invoiceFiles.delete).toHaveBeenCalledWith("file:///fake/x.pdf");
  });
});
