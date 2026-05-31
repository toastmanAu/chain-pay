import { runPipeline, type OcrFn } from "./pipeline";
import type { ExtractionResult, MapperFn, PageOcr, Stage0Output } from "./types";
import { extractFields } from "./rules";
import { mapSuryaPages } from "./surya-mapper";
import { makeSuryaOcr } from "./surya-ocr";
import { useInvoicesStore } from "@/stores/invoices";
import { useExtractionSettingsStore } from "@/stores/extraction-settings";

export interface ExtractionStoreSlice {
  markExtractionRunning: (id: string) => void;
  applyExtraction: (id: string, result: ExtractionResult) => void;
  markExtractionFailed: (id: string, error: string) => void;
}

export interface ExtractionDeps {
  ocr: OcrFn;
  mapper: MapperFn;
  rasterise?: (blob: Blob) => Promise<Stage0Output>;
}

interface QueueEntry { invoiceId: string; blob: Blob; resolve: () => void }

export class ExtractionService {
  private queue: QueueEntry[] = [];
  private running = false;
  private deps: ExtractionDeps;

  constructor(private store: ExtractionStoreSlice, deps: ExtractionDeps) {
    this.deps = deps;
  }

  setDeps(deps: ExtractionDeps): void {
    this.deps = deps;
  }

  enqueue(invoiceId: string, blob: Blob): Promise<void> {
    this.store.markExtractionRunning(invoiceId);
    return new Promise<void>((resolve) => {
      this.queue.push({ invoiceId, blob, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        const result = await runPipeline(entry.blob, this.deps);
        this.store.applyExtraction(entry.invoiceId, result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.store.markExtractionFailed(entry.invoiceId, reason);
      } finally {
        entry.resolve();
      }
    }
    this.running = false;
  }
}

// ---------------------------------------------------------------------------
// Real Web Worker wiring — renderer-only singleton
// ---------------------------------------------------------------------------

interface WorkerDoneMsg { type: "done"; jobId: string; pages: PageOcr[]; elapsed_ms: number; version: string }
interface WorkerErrMsg { type: "error"; jobId: string; reason: string }

let workerPromise: Promise<Worker> | null = null;

function bootWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    // Vite worker import — bundles the entrypoint as a Web Worker.
    const TesseractWorker = (await import("./worker.ts?worker")).default;
    return new TesseractWorker();
  })();
  return workerPromise;
}

let jobCounter = 0;

const realOcr: OcrFn = async (pages: ImageBitmap[]) => {
  const worker = await bootWorker();
  const jobId = `job_${++jobCounter}`;
  return await new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<WorkerDoneMsg | WorkerErrMsg>) => {
      if (e.data.jobId !== jobId) return;
      worker.removeEventListener("message", onMsg as EventListener);
      if (e.data.type === "done") {
        resolve({ pages: e.data.pages, elapsed_ms: e.data.elapsed_ms, version: e.data.version });
      } else {
        reject(new Error(e.data.reason));
      }
    };
    worker.addEventListener("message", onMsg as EventListener);
    worker.postMessage({ type: "recognize", jobId, pages }, pages);
  });
};

let _singleton: ExtractionService | null = null;

function buildBackendPair(): { ocr: OcrFn; mapper: MapperFn } {
  const settings = useExtractionSettingsStore.getState();
  if (settings.extractionBackend === "surya-remote") {
    return { ocr: makeSuryaOcr(settings.suryaEndpointUrl), mapper: mapSuryaPages };
  }
  return { ocr: realOcr, mapper: extractFields };
}

export function extractionService(): ExtractionService {
  const pair = buildBackendPair();
  if (_singleton) {
    _singleton.setDeps(pair);
    return _singleton;
  }
  const slice: ExtractionStoreSlice = {
    markExtractionRunning: useInvoicesStore.getState().markExtractionRunning,
    applyExtraction: useInvoicesStore.getState().applyExtraction,
    markExtractionFailed: useInvoicesStore.getState().markExtractionFailed,
  };
  _singleton = new ExtractionService(slice, pair);
  return _singleton;
}
