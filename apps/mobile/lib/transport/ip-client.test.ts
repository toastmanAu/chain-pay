import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendInvoiceViaIp, healthCheck, fetchCommPubkey } from "./ip-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const pairing = {
  rpc_url: "https://desk:8233/",
  auth_token: "tok",
  cert_fingerprint: "AB:CD",
  desktop_comm_pubkey: "0x" + "00".repeat(32),
};

describe("ip-client", () => {
  it("sendInvoice succeeds on 201 and returns invoiceId", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoiceId: "inv_x" }), { status: 201 }));
    const result = await sendInvoiceViaIp({
      pairing,
      payload: {
        id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1,
        extraction: { body: {}, field_confidences: {}, warnings: [] },
        image_chunks: ["AA"], image_mime: "image/jpeg",
      },
    });
    expect(result).toEqual({ ok: true, status: "created", invoiceId: "inv_x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://desk:8233/invoices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("sendInvoice treats 409 as duplicate-success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoiceId: "inv_y" }), { status: 409 }));
    const result = await sendInvoiceViaIp({
      pairing,
      payload: {
        id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1,
        extraction: { body: {}, field_confidences: {}, warnings: [] },
        image_chunks: ["AA"], image_mime: "image/jpeg",
      },
    });
    expect(result).toEqual({ ok: true, status: "duplicate", invoiceId: "inv_y" });
  });

  it("sendInvoice returns kind=unauthorized on 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const result = await sendInvoiceViaIp({ pairing, payload: {} as never });
    expect(result).toEqual({ ok: false, kind: "unauthorized" });
  });

  it("sendInvoice returns kind=server on 500", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const result = await sendInvoiceViaIp({ pairing, payload: {} as never });
    expect(result.ok).toBe(false);
    expect((result as { kind: string }).kind).toBe("server");
  });

  it("healthCheck returns true on 200 {ok:true}", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, app: "chainpay", version: "0" }), { status: 200 }));
    expect(await healthCheck(pairing)).toBe(true);
  });

  it("healthCheck returns false on network throw", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await healthCheck(pairing)).toBe(false);
  });

  it("fetchCommPubkey returns the pubkey on 200", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ comm_pubkey: "0x" + "ab".repeat(32) }), { status: 200 }));
    const result = await fetchCommPubkey(pairing);
    expect(result).toBe("0x" + "ab".repeat(32));
  });

  it("fetchCommPubkey returns null on 404", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    expect(await fetchCommPubkey(pairing)).toBeNull();
  });

  it("fetchCommPubkey returns null on malformed body", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }));
    expect(await fetchCommPubkey(pairing)).toBeNull();
  });
});
