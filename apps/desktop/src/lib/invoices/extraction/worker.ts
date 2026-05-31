/// <reference lib="webworker" />

import Tesseract from "tesseract.js";
import tesseractPkg from "tesseract.js/package.json";
import type { PageOcr } from "./types";

type TWorker = Tesseract.Worker;

interface RecognizeRequest {
  type: "recognize";
  jobId: string;
  pages: ImageBitmap[];
}
interface PingRequest { type: "ping"; jobId: string }
type Request = RecognizeRequest | PingRequest;

interface ResponseOk {
  type: "done";
  jobId: string;
  pages: PageOcr[];
  elapsed_ms: number;
  version: string;
}
interface ResponseErr { type: "error"; jobId: string; reason: string }
interface ResponsePong { type: "pong"; jobId: string }
type Response = ResponseOk | ResponseErr | ResponsePong;

let cachedWorker: TWorker | null = null;
async function getWorker(): Promise<TWorker> {
  if (cachedWorker) return cachedWorker;
  cachedWorker = await Tesseract.createWorker("eng");
  return cachedWorker;
}

async function bitmapToCanvas(bitmap: ImageBitmap): Promise<OffscreenCanvas> {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D unavailable in worker");
  ctx.drawImage(bitmap, 0, 0);
  return c;
}

function post(msg: Response): void {
  (self as unknown as { postMessage: (m: Response) => void }).postMessage(msg);
}

self.addEventListener("message", async (e: MessageEvent<Request>) => {
  const req = e.data;
  if (req.type === "ping") {
    post({ type: "pong", jobId: req.jobId });
    return;
  }
  if (req.type === "recognize") {
    const t0 = performance.now();
    try {
      const worker = await getWorker();
      const out: PageOcr[] = [];
      for (let i = 0; i < req.pages.length; i++) {
        const page = req.pages[i];
        if (!page) throw new Error(`BUG: req.pages[${i}] is undefined — Stage 0 should produce a dense array`);
        const canvas = await bitmapToCanvas(page);
        const { data } = await worker.recognize(canvas);
        const lines: PageOcr["lines"] = (data.lines ?? []).map((l) => ({
          text: l.text,
          bbox: { x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 },
          confidence: l.confidence,
        }));
        out.push({ pageIndex: i, text: data.text, lines });
      }
      const elapsed_ms = Math.round(performance.now() - t0);
      post({
        type: "done",
        jobId: req.jobId,
        pages: out,
        elapsed_ms,
        version: tesseractPkg.version,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      post({ type: "error", jobId: req.jobId, reason });
    }
  }
});

export {}; // make this a module
