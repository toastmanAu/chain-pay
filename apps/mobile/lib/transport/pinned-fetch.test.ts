import { describe, it, expect, vi, beforeEach } from "vitest";
import { pinnedFetch } from "./pinned-fetch";
import { ExpoTlsPin } from "@/modules/expo-tls-pin/src";

const requestMock = ExpoTlsPin.request as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => requestMock.mockReset());

describe("pinned-fetch", () => {
  it("returns ok:true on a 200 response with body", async () => {
    requestMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toEqual({ hello: "world" });
    }
  });

  it("passes fingerprint through to the native module", async () => {
    requestMock.mockResolvedValue({ ok: true, status: 204, headers: {}, body: "" });
    await pinnedFetch(
      "https://x:1/foo",
      { method: "POST", body: '{"a":1}', headers: { Authorization: "Bearer t" } },
      "AB:CD:EF",
    );
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://x:1/foo",
        method: "POST",
        body: '{"a":1}',
        headers: { Authorization: "Bearer t" },
        fingerprint: "AB:CD:EF",
      }),
    );
  });

  it("returns kind=tls-mismatch when native module reports it", async () => {
    requestMock.mockResolvedValue({ ok: false, kind: "tls-mismatch", detail: "fingerprint mismatch" });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result).toEqual({ ok: false, kind: "tls-mismatch" });
  });

  it("returns kind=network on connection errors", async () => {
    requestMock.mockResolvedValue({ ok: false, kind: "network", detail: "ECONNREFUSED" });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result).toEqual({ ok: false, kind: "network", detail: "ECONNREFUSED" });
  });

  it("returns kind=network if the native module throws", async () => {
    requestMock.mockRejectedValueOnce(new Error("module crashed"));
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("network");
  });
});
