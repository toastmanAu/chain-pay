import type { Stage0Output } from "./types";

const PDF_RENDER_DPI = 200;
const POINTS_PER_INCH = 72;
const PDF_SCALE = PDF_RENDER_DPI / POINTS_PER_INCH;

async function rasteriseImage(blob: Blob): Promise<Stage0Output> {
  const bitmap = await createImageBitmap(blob);
  return { pages: [bitmap], pageCount: 1 };
}

async function rasterisePdf(blob: Blob): Promise<Stage0Output> {
  const pdfjs = await import("pdfjs-dist");
  const buf = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: ImageBitmap[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D unavailable");
    // pdfjs-dist v4 RenderParameters uses canvasContext only (no separate canvas property)
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    pages.push(canvas.transferToImageBitmap());
  }
  return { pages, pageCount: doc.numPages };
}

export async function rasterise(blob: Blob): Promise<Stage0Output> {
  if (blob.type === "image/png" || blob.type === "image/jpeg") {
    return rasteriseImage(blob);
  }
  if (blob.type === "application/pdf") {
    return rasterisePdf(blob);
  }
  throw new Error(`Unsupported MIME for extraction: ${blob.type}`);
}
