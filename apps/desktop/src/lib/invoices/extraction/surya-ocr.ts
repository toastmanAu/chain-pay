import type { OcrFn } from "./pipeline";
import type { PageOcr } from "./types";
import { SuryaContentError, SuryaInfraError } from "./types";

const PROMPT = "Convert this document page to HTML, including bounding boxes for each layout block.";
const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 8192;

export function assertWellFormed(html: string): void {
  const trimmed = html.trimEnd();
  if (!trimmed.endsWith("</div>") && !trimmed.endsWith("</p>") && !trimmed.endsWith("</table>")) {
    throw new SuryaContentError(`response appears truncated (ends with: ${trimmed.slice(-50)})`);
  }
  const divOpen = (html.match(/<div\b/g) ?? []).length;
  const divClose = (html.match(/<\/div>/g) ?? []).length;
  if (divOpen !== divClose) {
    throw new SuryaContentError(`unbalanced <div>: open=${divOpen}, close=${divClose}`);
  }
  const pOpen = (html.match(/<p\b/g) ?? []).length;
  const pClose = (html.match(/<\/p>/g) ?? []).length;
  if (pOpen !== pClose) {
    throw new SuryaContentError(`unbalanced <p>: open=${pOpen}, close=${pClose}`);
  }
}

async function imageBitmapToPngBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new SuryaInfraError("OffscreenCanvas 2D unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function blobToDataUri(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 65536;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function callSurya(endpointUrl: string, dataUri: string, signal: AbortSignal): Promise<string> {
  const body = {
    model: "surya",
    temperature: 0,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  };
  let resp: Response;
  try {
    resp = await fetch(`${endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const host = endpointHost(endpointUrl);
    throw new SuryaInfraError(`Surya endpoint at ${host} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new SuryaInfraError(`Surya endpoint rejected the request (auth) — check URL`);
  }
  if (resp.status >= 500 && resp.status < 600) {
    throw new SuryaInfraError(`Surya endpoint returned ${resp.status} — server may be overloaded or restarting`);
  }
  if (resp.status >= 400) {
    throw new SuryaInfraError(`Surya endpoint rejected the request body (${resp.status}) — please file a bug`);
  }
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = await resp.json();
  } catch {
    throw new SuryaContentError(`Surya endpoint didn't return valid JSON`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new SuryaContentError(`Surya response missing choices[0].message.content`);
  }
  return content;
}

export function makeSuryaOcr(endpointUrl: string): OcrFn {
  return async (pages: ImageBitmap[]) => {
    const t0 = performance.now();
    const out: PageOcr[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page) throw new SuryaInfraError(`BUG: pages[${i}] is undefined`);
      const pngBlob = await imageBitmapToPngBlob(page);
      const dataUri = await blobToDataUri(pngBlob);
      const html = await callSurya(endpointUrl, dataUri, AbortSignal.timeout(TIMEOUT_MS));
      assertWellFormed(html);
      out.push({ pageIndex: i, text: html, lines: [] });
    }
    return { pages: out, elapsed_ms: Math.round(performance.now() - t0), version: "surya-2-gguf" };
  };
}
