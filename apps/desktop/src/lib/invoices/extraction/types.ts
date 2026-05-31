import type { Invoice } from "@chain-pay/shared";

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number; // 0-100 from tesseract; normalised to 0-1 elsewhere if needed
}

export interface PageOcr {
  pageIndex: number;
  text: string;
  lines: OcrLine[];
}

export interface Stage0Output {
  pages: ImageBitmap[];
  pageCount: number;
}

export interface ExtractionResult {
  stages: Invoice["extraction"]["pipeline"]["stages"];
  body: Partial<Invoice["invoice"]>;
  field_confidences: Record<string, number>;
  warnings: NonNullable<Invoice["extraction"]["warnings"]>;
}

export interface ExtractionFailure {
  reason: string;
}
