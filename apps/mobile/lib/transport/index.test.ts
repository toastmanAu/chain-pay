import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectTransportFor, runDrainOnce } from "./index";
import * as ip from "./ip-client";

vi.mock("./ip-client");

const pairing = {
  rpc_url: "https://desk:8233/", auth_token: "tok", cert_fingerprint: "AB",
  desktop_comm_pubkey: "0x" + "00".repeat(32),
};

beforeEach(() => {
  vi.mocked(ip.sendInvoiceViaIp).mockReset();
});

describe("transport selector (v1: IP-only)", () => {
  it("selectTransportFor always returns 'ip' in v1", () => {
    expect(selectTransportFor("pending")).toBe("ip");
    expect(selectTransportFor("pending-cellular")).toBe("ip");
  });
});

describe("runDrainOnce", () => {
  const item = {
    id: "01HXYZABCDEFGHJKMNPQRSTVWX",
    capturedAt: 1,
    imageRef: "x.jpg",
    extraction: { body: {}, field_confidences: {}, warnings: [] },
    status: "pending" as const,
    attempts: 0,
  };
  const buildPayload = vi.fn(async () => ({
    id: item.id, capturedAt: item.capturedAt, extraction: item.extraction,
    image_chunks: ["AAAA"], image_mime: "image/jpeg" as const,
  }));

  it("dispatches via IP for pending and reports created", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: true, status: "created", invoiceId: "inv_z" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out).toEqual({ kind: "synced", invoiceId: "inv_z" });
    expect(ip.sendInvoiceViaIp).toHaveBeenCalled();
  });

  it("returns 'unauthorized' when IP returns 401", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "unauthorized" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out.kind).toBe("unauthorized");
  });

  it("returns 'retry' on network/server errors", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "server", detail: "boom" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out).toEqual({ kind: "retry", error: "boom" });
  });

  it("returns 'tls-mismatch' when ip-client reports it", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "tls-mismatch" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out).toEqual({ kind: "tls-mismatch" });
  });
});
