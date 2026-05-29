import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => "/unused" } }));

import { storeInvoiceFile, readInvoiceFile, deleteInvoiceFile, __resetForTest } from "./invoice-files-host";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "invoice-files-host-"));
  __resetForTest(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("invoice-files-host", () => {
  it("storeInvoiceFile writes content-addressed file and returns file:// URI", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = "deadbeef".repeat(8); // 64 hex chars
    const uri = await storeInvoiceFile(bytes, sha256);
    expect(uri.startsWith("file://")).toBe(true);
    expect(uri.endsWith(`${sha256}.pdf`)).toBe(true);
    expect(existsSync(join(tmpRoot, "invoice-pdfs", "de", `${sha256}.pdf`))).toBe(true);
  });

  it("storeInvoiceFile is idempotent on duplicate sha256", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = "feedface".repeat(8);
    const uri1 = await storeInvoiceFile(bytes, sha256);
    const uri2 = await storeInvoiceFile(bytes, sha256);
    expect(uri1).toBe(uri2);
  });

  it("readInvoiceFile reads back the bytes", async () => {
    const bytes = new Uint8Array([42, 7, 99]);
    const sha256 = "abcdef00".repeat(8);
    const uri = await storeInvoiceFile(bytes, sha256);
    const read = await readInvoiceFile(uri);
    expect(Array.from(read)).toEqual([42, 7, 99]);
  });

  it("deleteInvoiceFile removes the file", async () => {
    const bytes = new Uint8Array([1]);
    const sha256 = "11223344".repeat(8);
    const uri = await storeInvoiceFile(bytes, sha256);
    await deleteInvoiceFile(uri);
    expect(existsSync(join(tmpRoot, "invoice-pdfs", "11", `${sha256}.pdf`))).toBe(false);
  });

  it("storeInvoiceFile rejects an invalid sha256", async () => {
    await expect(storeInvoiceFile(new Uint8Array([1]), "not-hex")).rejects.toThrow(/invalid sha256/);
  });

  it("readInvoiceFile rejects URIs outside the invoice-pdfs root (path traversal guard)", async () => {
    // Construct a file:// URI pointing outside the tmpRoot/invoice-pdfs directory
    const evilPath = join(tmpRoot, "..", "evil.pdf");
    const { pathToFileURL } = await import("node:url");
    const evilUri = pathToFileURL(evilPath).toString();
    await expect(readInvoiceFile(evilUri)).rejects.toThrow(/outside invoice-pdfs root/);
  });
});
