import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "./pipeline";
import type { PageOcr } from "./types";

const fakePages: PageOcr[] = [{ pageIndex: 0, text: "Total: $42.00", lines: [{ text: "Total: $42.00", bbox: { x0: 0, y0: 800, x1: 100, y1: 820 }, confidence: 95 }] }];

describe("runPipeline", () => {
  it("emits two pipeline.stages entries in order (layout-ocr then schema-extraction)", async () => {
    const fakeOcr = vi.fn(async () => ({ pages: fakePages, elapsed_ms: 100, version: "5.1.1" }));
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    const result = await runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr });
    expect(result.stages.map((s) => s.name)).toEqual(["layout-ocr", "schema-extraction"]);
    expect(result.body.total).toBe(42);
  });

  it("propagates OCR worker errors as a thrown failure with reason", async () => {
    const fakeOcr = vi.fn(async () => { throw new Error("WASM init failed"); });
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    await expect(runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr }))
      .rejects.toThrow(/WASM init failed/);
  });

  it("records elapsed_ms on stage 1", async () => {
    const fakeOcr = vi.fn(async () => ({ pages: fakePages, elapsed_ms: 1234, version: "5.1.1" }));
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    const result = await runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr });
    expect(result.stages[0].elapsed_ms).toBe(1234);
  });
});
