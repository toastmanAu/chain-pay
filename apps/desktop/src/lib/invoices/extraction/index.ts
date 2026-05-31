import { runPipeline, type OcrFn } from "./pipeline";
import type { ExtractionResult, Stage0Output } from "./types";

export interface ExtractionStoreSlice {
  markExtractionRunning: (id: string) => void;
  applyExtraction: (id: string, result: ExtractionResult) => void;
  markExtractionFailed: (id: string, error: string) => void;
}

export interface ExtractionDeps {
  ocr: OcrFn;
  rasterise?: (blob: Blob) => Promise<Stage0Output>;
}

interface QueueEntry { invoiceId: string; blob: Blob; resolve: () => void }

export class ExtractionService {
  private queue: QueueEntry[] = [];
  private running = false;

  constructor(private store: ExtractionStoreSlice, private deps: ExtractionDeps) {}

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
