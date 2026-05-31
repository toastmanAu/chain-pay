// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSuryaOcr, assertWellFormed } from "./surya-ocr";
import { SuryaContentError, SuryaInfraError } from "./types";

const fetchMock = vi.fn();
const fakeBitmap = { width: 10, height: 10 } as unknown as ImageBitmap;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("OffscreenCanvas", class {
    width = 10;
    height = 10;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return { drawImage: vi.fn() }; }
    convertToBlob() { return Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function chatResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("makeSuryaOcr", () => {
  it("returns PageOcr[] with full HTML in .text on happy path", async () => {
    fetchMock.mockResolvedValue(chatResponse(`<div data-bbox="0 0 10 10" data-label="Text"><p>hi</p></div>`));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    const out = await ocr([fakeBitmap]);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]!.text).toContain(`data-bbox="0 0 10 10"`);
    expect(out.pages[0]!.lines).toEqual([]);
    expect(out.version).toBe("surya-2-gguf");
    expect(out.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("throws SuryaInfraError on fetch reject (network refused)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    await expect(ocr([fakeBitmap])).rejects.toBeInstanceOf(SuryaInfraError);
  });

  it("throws SuryaInfraError on HTTP 502", async () => {
    fetchMock.mockResolvedValue(new Response("upstream", { status: 502 }));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    await expect(ocr([fakeBitmap])).rejects.toBeInstanceOf(SuryaInfraError);
  });

  it("throws SuryaInfraError on HTTP 401 with auth hint", async () => {
    fetchMock.mockResolvedValue(new Response("auth", { status: 401 }));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    await expect(ocr([fakeBitmap])).rejects.toThrow(/auth/i);
  });

  it("throws SuryaContentError on non-JSON response", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    await expect(ocr([fakeBitmap])).rejects.toBeInstanceOf(SuryaContentError);
  });

  it("throws SuryaContentError on truncated HTML (no closing tag)", async () => {
    fetchMock.mockResolvedValue(chatResponse(`<div data-bbox="0 0 10 10"><p>oops, no close`));
    const ocr = makeSuryaOcr("http://localhost:9991/v1");
    await expect(ocr([fakeBitmap])).rejects.toBeInstanceOf(SuryaContentError);
  });
});

describe("assertWellFormed", () => {
  it("passes well-formed HTML ending in </div>", () => {
    expect(() => assertWellFormed(`<div data-bbox="0 0 1 1"><p>x</p></div>`)).not.toThrow();
  });

  it("throws SuryaContentError when HTML does not end with closing tag", () => {
    expect(() => assertWellFormed(`<div>partial`)).toThrow(SuryaContentError);
  });

  it("throws SuryaContentError when <div> counts are unbalanced", () => {
    expect(() => assertWellFormed(`<div><div>nested</div></p>`)).toThrow(SuryaContentError);
  });

  it("accepts trailing whitespace", () => {
    expect(() => assertWellFormed(`<div>ok</div>   \n`)).not.toThrow();
  });
});
