import type { ExtractionResult, MapperFn, PageOcr, Stage0Output } from "./types";
import { rasterise as defaultRasterise } from "./rasterise";

export interface OcrFn {
  (pages: ImageBitmap[]): Promise<{ pages: PageOcr[]; elapsed_ms: number; version: string }>;
}

export interface PipelineDeps {
  rasterise?: (blob: Blob) => Promise<Stage0Output>;
  ocr: OcrFn;
  mapper: MapperFn;
}

export async function runPipeline(blob: Blob, deps: PipelineDeps): Promise<ExtractionResult> {
  const rasterise = deps.rasterise ?? defaultRasterise;
  const stage0 = await rasterise(blob);
  const stage1 = await deps.ocr(stage0.pages);
  const stage2 = deps.mapper(stage1.pages);
  return {
    stages: [
      { name: "layout-ocr", model: "tesseract.js", version: stage1.version, elapsed_ms: stage1.elapsed_ms },
      ...stage2.stages,
    ],
    body: stage2.body,
    field_confidences: stage2.field_confidences,
    warnings: stage2.warnings,
  };
}
