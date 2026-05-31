import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtractionService, type ExtractionStoreSlice } from "./index";

interface FakeStore {
  markExtractionRunning: ReturnType<typeof vi.fn>;
  applyExtraction: ReturnType<typeof vi.fn>;
  markExtractionFailed: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore {
  return {
    markExtractionRunning: vi.fn(),
    applyExtraction: vi.fn(),
    markExtractionFailed: vi.fn(),
  };
}

describe("ExtractionService", () => {
  let store: FakeStore;
  beforeEach(() => { store = fakeStore(); });

  it("enqueue moves invoice through running -> extracted (happy path)", async () => {
    let resolveOcr: (v: { pages: []; elapsed_ms: number; version: string }) => void = () => {};
    const ocr = vi.fn(() => new Promise<{ pages: []; elapsed_ms: number; version: string }>((r) => { resolveOcr = r; }));
    const rasterise = vi.fn(async () => ({ pages: [], pageCount: 0 }));
    const svc = new ExtractionService(store as unknown as ExtractionStoreSlice, { ocr, rasterise });
    const done = svc.enqueue("inv_1", new Blob([], { type: "image/png" }));
    // synchronously moved to running
    expect(store.markExtractionRunning).toHaveBeenCalledWith("inv_1");
    // yield one microtask so pump can advance past rasterise and call ocr,
    // which sets resolveOcr to the real resolver
    await Promise.resolve();
    resolveOcr({ pages: [], elapsed_ms: 50, version: "5.1.1" });
    await done;
    expect(store.applyExtraction).toHaveBeenCalledWith("inv_1", expect.objectContaining({
      stages: expect.any(Array),
    }));
  });

  it("enqueue calls markExtractionFailed on worker error", async () => {
    const ocr = vi.fn(async () => { throw new Error("WASM init failed"); });
    const rasterise = vi.fn(async () => ({ pages: [], pageCount: 0 }));
    const svc = new ExtractionService(store as unknown as ExtractionStoreSlice, { ocr, rasterise });
    await svc.enqueue("inv_1", new Blob([], { type: "image/png" }));
    expect(store.markExtractionFailed).toHaveBeenCalledWith("inv_1", expect.stringContaining("WASM init failed"));
  });

  it("concurrency=1: second enqueue waits for first to finish", async () => {
    const order: string[] = [];
    const ocr = vi.fn(async () => { order.push("ocr"); return { pages: [] as [], elapsed_ms: 1, version: "5.1.1" }; });
    const rasterise = vi.fn(async () => { order.push("ras"); return { pages: [], pageCount: 0 }; });
    const svc = new ExtractionService(store as unknown as ExtractionStoreSlice, { ocr, rasterise });
    const a = svc.enqueue("inv_a", new Blob([], { type: "image/png" }));
    const b = svc.enqueue("inv_b", new Blob([], { type: "image/png" }));
    await Promise.all([a, b]);
    // expect first job's ras+ocr to complete before second starts
    expect(order).toEqual(["ras", "ocr", "ras", "ocr"]);
  });
});
