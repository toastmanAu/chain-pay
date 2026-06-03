import { ExpoTlsPin } from "@/modules/expo-tls-pin/src";

export type PinnedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; kind: "tls-mismatch" }
  | { ok: false; kind: "network"; detail: string };

export async function pinnedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  fingerprint: string,
): Promise<PinnedFetchResult> {
  try {
    const result = await ExpoTlsPin.request({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
      fingerprint,
    });
    if (result.ok) {
      const response = new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
      return { ok: true, response };
    }
    if (result.kind === "tls-mismatch") return { ok: false, kind: "tls-mismatch" };
    return { ok: false, kind: "network", detail: result.detail };
  } catch (e) {
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
}
