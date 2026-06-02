import { Platform } from "react-native";
import TextRecognition from "@react-native-ml-kit/text-recognition";

export interface OcrLine {
  text: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  fullText: string;
  lines: OcrLine[];
}

export async function recognizeText(imageUri: string): Promise<OcrResult> {
  try {
    if (Platform.OS === "ios") return await runVision(imageUri);
    return await runMlKit(imageUri);
  } catch {
    return { fullText: "", lines: [] };
  }
}

async function runMlKit(uri: string): Promise<OcrResult> {
  const out = await TextRecognition.recognize(uri);
  const lines: OcrLine[] = [];
  for (const block of out.blocks ?? []) {
    for (const line of block.lines ?? []) {
      lines.push({
        text: line.text,
        box: {
          x: line.frame?.left ?? 0,
          y: line.frame?.top ?? 0,
          w: line.frame?.width ?? 0,
          h: line.frame?.height ?? 0,
        },
      });
    }
  }
  return { fullText: out.text ?? "", lines };
}

async function runVision(uri: string): Promise<OcrResult> {
  // iOS: same package — it falls back to Vision-framework-equivalent on iOS via native module.
  // If a separate Vision-specific module is preferred later, swap this implementation.
  return runMlKit(uri);
}
