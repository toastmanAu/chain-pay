// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { rasterise } from "./rasterise";

describe("rasterise", () => {
  it("passes through PNG as a single page", async () => {
    const fakeBitmap = { width: 1, height: 1 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => fakeBitmap));
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const out = await rasterise(blob);
    expect(out.pageCount).toBe(1);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]).toBe(fakeBitmap);
    vi.unstubAllGlobals();
  });

  it("passes through JPG as a single page", async () => {
    const fakeBitmap = { width: 1, height: 1 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => fakeBitmap));
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    const out = await rasterise(blob);
    expect(out.pageCount).toBe(1);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]).toBe(fakeBitmap);
    vi.unstubAllGlobals();
  });

  it("rejects unsupported MIME", async () => {
    const blob = new Blob([new Uint8Array([0])], { type: "text/plain" });
    await expect(rasterise(blob)).rejects.toThrow(/unsupported/i);
  });
});
