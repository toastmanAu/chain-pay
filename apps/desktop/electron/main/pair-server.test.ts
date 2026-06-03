import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { Agent } from "undici";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");
const { initBiscuit, generateRootKeypair, issueCaptureV1Token } = await import("./pair-server-biscuit");
const { _setPairStoreFileForTests, addDevice } = await import("./pair-store");
const { startPairServer, stopPairServer } = await import("./pair-server");
const { _setTlsCertFileForTests, _resetTlsCertCacheForTests, loadOrCreateTlsCert } = await import("./tls-cert-store");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pair-server-test-"));
const storeFile = path.join(tmpDir, "paired-devices.enc");

let baseUrl = "";
let certFingerprint = "";
let dispatcher: Agent;
let rootKeypair: ReturnType<typeof generateRootKeypair>;
let validToken: string;
let validTokenId: string;
const rendererSend = vi.fn();

beforeAll(async () => {
  await initBiscuit();
  resetSafeStorageForTests();
  _setPairStoreFileForTests(storeFile);
  rootKeypair = generateRootKeypair();
  const issued = issueCaptureV1Token({
    root: rootKeypair,
    deviceLabel: "phone-1",
    expiresAtRfc3339: "2099-01-01T00:00:00Z",
  });
  validToken = issued.token;
  validTokenId = issued.tokenId;
  await addDevice({
    tokenId: validTokenId,
    deviceLabel: "phone-1",
    commPubkey: "0x" + "ab".repeat(32),
    capabilities: ['write("invoices")'],
    issuedAt: 0,
    expiresAt: 4102444800000,
  });
  const tlsTmpFile = path.join(tmpDir, "tls-cert.enc");
  _setTlsCertFileForTests(tlsTmpFile);
  _resetTlsCertCacheForTests();
  const tlsCert = await loadOrCreateTlsCert();
  const started = await startPairServer({
    port: 0,
    rootKeypair,
    appVersion: "0.4.0-test",
    sendToRenderer: { send: rendererSend } as unknown as Electron.WebContents,
    mdns: false,
    commPubkey: "0x" + "ff".repeat(32),
    tlsCert: { key: tlsCert.key, cert: tlsCert.cert },
  });
  baseUrl = `https://127.0.0.1:${started.port}`;
  certFingerprint = started.certFingerprint;
  // Scoped trust: trust the server's actual cert as a CA, only for this dispatcher.
  // No global TLS-reject toggling — that would leak across the whole process.
  dispatcher = new Agent({ connect: { ca: started.certPem } });
});

afterAll(async () => {
  await dispatcher.close();
  await stopPairServer();
});

beforeEach(() => rendererSend.mockReset());

async function call(p: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(baseUrl + p, {
    ...init,
    headers: { ...init.headers, "Content-Type": "application/json" },
    // @ts-expect-error — undici's `dispatcher` is recognized by node:fetch at runtime
    dispatcher,
  });
}

describe("pair-server routes", () => {
  it("GET /health returns ok envelope", async () => {
    const r = await call("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, app: "chainpay" });
  });

  it("GET /comm-pubkey returns the desktop comm pubkey", async () => {
    const r = await call("/comm-pubkey");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ comm_pubkey: "0x" + "ff".repeat(32) });
  });

  it("POST /invoices without Authorization returns 401", async () => {
    const r = await call("/invoices", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("POST /invoices with valid token + valid payload returns 201", async () => {
    const payload = {
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [Buffer.from("x").toString("base64")],
      image_mime: "image/jpeg",
    };
    const r = await call("/invoices", {
      method: "POST",
      headers: { Authorization: `Bearer ${validToken}` },
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(201);
    expect(rendererSend).toHaveBeenCalledWith(
      "mobile-invoice:received",
      expect.objectContaining({ sourceLabel: "phone-1" }),
    );
  });

  it("exposes certFingerprint for QR payload", () => {
    expect(certFingerprint).toMatch(/^[A-F0-9:]{95}$/i);
  });

  it("POST /invoices with revoked token returns 401", async () => {
    // Issue a fresh token, register the device, then revoke
    const { revokeDevice } = await import("./pair-store");
    const fresh = issueCaptureV1Token({
      root: rootKeypair,
      deviceLabel: "to-be-revoked",
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    });
    await addDevice({
      tokenId: fresh.tokenId,
      deviceLabel: "to-be-revoked",
      commPubkey: "0x" + "cc".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: 0,
      expiresAt: 4102444800000,
    });
    await revokeDevice(fresh.tokenId);

    const payload = {
      id: "01HXYZABCDEFGHJKMNPQRSTVW2",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [Buffer.from("y").toString("base64")],
      image_mime: "image/jpeg",
    };
    const r = await call("/invoices", {
      method: "POST",
      headers: { Authorization: `Bearer ${fresh.token}` },
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(401);
  });

  it("POST /invoices duplicate id returns 409", async () => {
    const payload = {
      id: "01HXYZABCDEFGHJKMNPQRSTVW3",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [Buffer.from("z").toString("base64")],
      image_mime: "image/jpeg",
    };
    const first = await call("/invoices", {
      method: "POST",
      headers: { Authorization: `Bearer ${validToken}` },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const second = await call("/invoices", {
      method: "POST",
      headers: { Authorization: `Bearer ${validToken}` },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(409);
  });

  it("POST /pair returns 501 (not implemented)", async () => {
    const r = await call("/pair", {
      method: "POST",
      body: JSON.stringify({ phone_comm_pubkey: "0x" + "00".repeat(32), device_label: "x" }),
    });
    expect(r.status).toBe(501);
  });

  it("restartWithCert hot-swaps the cert and exposes a new fingerprint", async () => {
    const { rotateTlsCert } = await import("./tls-cert-store");
    const newCert = await rotateTlsCert();
    const { restartWithCert } = await import("./pair-server");
    const started = await restartWithCert({ key: newCert.key, cert: newCert.cert });
    expect(started.certFingerprint).toBe(newCert.fingerprint);
    expect(started.certFingerprint).not.toBe(certFingerprint);

    // health still works at the new fingerprint
    const newDispatcher = new Agent({ connect: { ca: started.certPem } });
    try {
      const r = await fetch(`https://127.0.0.1:${started.port}/health`, {
        // @ts-expect-error — undici dispatcher
        dispatcher: newDispatcher,
      });
      expect(r.status).toBe(200);
    } finally {
      await newDispatcher.close();
    }
  });
});
