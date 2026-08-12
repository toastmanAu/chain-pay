import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Agent } from "undici";
import { ulid } from "ulid";
import {
  createFiberConnectUri,
  parseFiberConnectUri,
  MobileInvoicePayloadSchema,
} from "@chain-pay/shared";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");
const { initBiscuit, generateRootKeypair, issueCaptureV1Token } = await import(
  "./pair-server-biscuit"
);
const { _setPairStoreFileForTests, addDevice } = await import("./pair-store");
const { startPairServer, stopPairServer } = await import("./pair-server");
const { _setTlsCertFileForTests, _resetTlsCertCacheForTests, loadOrCreateTlsCert } = await import(
  "./tls-cert-store"
);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-"));
const rendererSend = vi.fn();
let baseUri = "";
let dispatcher: Agent;

beforeAll(async () => {
  await initBiscuit();
  resetSafeStorageForTests();
  _setPairStoreFileForTests(path.join(tmpDir, "paired.enc"));

  const root = generateRootKeypair();
  const token = issueCaptureV1Token({
    root,
    deviceLabel: "phone",
    expiresAtRfc3339: "2099-01-01T00:00:00Z",
  });
  await addDevice({
    tokenId: token.tokenId,
    deviceLabel: "phone",
    commPubkey: "0x" + "00".repeat(32),
    capabilities: ['write("invoices")'],
    issuedAt: 0,
    expiresAt: 4102444800000,
  });

  _setTlsCertFileForTests(path.join(tmpDir, "tls-cert.enc"));
  _resetTlsCertCacheForTests();
  const tlsCert = await loadOrCreateTlsCert();
  const started = await startPairServer({
    port: 0,
    rootKeypair: root,
    appVersion: "0.4.0-e2e",
    sendToRenderer: { send: rendererSend } as unknown as Electron.WebContents,
    mdns: false,
    commPubkey: "0x" + "ff".repeat(32),
    tlsCert: { key: tlsCert.key, cert: tlsCert.cert },
  });

  baseUri = createFiberConnectUri({
    rpc_url: `https://127.0.0.1:${started.port}`,
    auth_token: token.token,
    cert_fingerprint: started.certFingerprint,
  });
  dispatcher = new Agent({ connect: { ca: started.certPem } });
});

afterAll(async () => {
  await dispatcher.close();
  await stopPairServer();
});

describe("pair-server end-to-end", () => {
  it("round-trips three fixture invoices via FiberConnect URI", async () => {
    const pairing = parseFiberConnectUri(baseUri);
    const imgPath = path.resolve(
      __dirname,
      "../../../mobile/__fixtures__/invoices/sample.jpg",
    );
    const img = await fs.readFile(imgPath);
    const chunkSize = 256 * 1024;
    const chunks: string[] = [];
    for (let off = 0; off < img.length; off += chunkSize) {
      chunks.push(img.subarray(off, off + chunkSize).toString("base64"));
    }

    for (let i = 0; i < 3; i++) {
      const payload = MobileInvoicePayloadSchema.parse({
        id: ulid(),
        capturedAt: Date.now(),
        extraction: {
          body: { invoice_number: `INV-${i}` },
          field_confidences: {},
          warnings: [],
        },
        image_chunks: chunks,
        image_mime: "image/jpeg",
      });
      const res = await fetch(`${pairing.rpc_url}invoices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pairing.auth_token}`,
        },
        body: JSON.stringify(payload),
        // @ts-expect-error — undici dispatcher accepted by node:fetch at runtime
        dispatcher,
      });
      expect(res.status).toBe(201);
    }
    expect(rendererSend).toHaveBeenCalledTimes(3);
  });

  it("rotates cert + verifies old dispatcher rejected + new dispatcher works", async () => {
    const { rotateTlsCert } = await import("./tls-cert-store");
    const { restartWithCert } = await import("./pair-server");

    const oldDispatcher = dispatcher;
    const rotated = await rotateTlsCert();
    const restarted = await restartWithCert({ key: rotated.key, cert: rotated.cert });

    // Old dispatcher's CA no longer matches → handshake fails.
    let oldError: unknown;
    try {
      await fetch(`https://127.0.0.1:${restarted.port}/health`, {
        // @ts-expect-error — undici dispatcher
        dispatcher: oldDispatcher,
      });
    } catch (err) {
      oldError = err;
    }
    expect(oldError).toBeDefined();
    const causeMsg =
      (oldError as { cause?: { message?: string; code?: string } })?.cause?.message ??
      (oldError as { cause?: { code?: string } })?.cause?.code ??
      (oldError as Error)?.message ??
      "";
    expect(causeMsg).toMatch(/certificate|self-signed|altname|unable|CERT|TLS/i);

    // New dispatcher with the new CA succeeds.
    const newDispatcher = new Agent({ connect: { ca: restarted.certPem } });
    try {
      const res = await fetch(`https://127.0.0.1:${restarted.port}/health`, {
        // @ts-expect-error — undici dispatcher
        dispatcher: newDispatcher,
      });
      expect(res.status).toBe(200);
    } finally {
      await newDispatcher.close();
    }
  });
});
