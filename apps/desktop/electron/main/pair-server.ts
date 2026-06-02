import https from "node:https";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import Bonjour from "bonjour-service";
import selfsigned from "selfsigned";
import { MobileInvoicePayloadSchema, MOBILE_ROUTES } from "@chain-pay/shared";
import { verifyToken, type RootKeypair } from "./pair-server-biscuit";
import { getDeviceByTokenId, isRevoked } from "./pair-store";
import { receiveMobileInvoice } from "./invoice-receiver";

const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

interface StartArgs {
  port: number;
  rootKeypair: RootKeypair;
  appVersion: string;
  sendToRenderer: Electron.WebContents;
  mdns: boolean;
  commPubkey: string;
}

interface StartResult {
  port: number;
  certFingerprint: string;
  certPem: string;
}

interface BonjourLike {
  publish(opts: { name: string; type: string; port: number }): unknown;
  unpublishAll(cb?: () => void): void;
  destroy(cb?: () => void): void;
}

let serverHandle: { server: https.Server; bonjour: BonjourLike | null } | null = null;

export async function startPairServer(args: StartArgs): Promise<StartResult> {
  const attrs = [{ name: "commonName", value: os.hostname() || "chainpay" }];
  // selfsigned defaults algorithm to sha1; force sha256 so the certificate
  // signature matches the SHA-256 fingerprint we expose for QR pairing.
  // Include subjectAltName for localhost + 127.0.0.1 + the hostname so
  // TLS hostname verification succeeds on the same machine and over LAN.
  const extensions = [
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 2, value: os.hostname() || "chainpay" },
        { type: 7, ip: "127.0.0.1" },
        { type: 7, ip: "::1" },
      ],
    },
  ];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: "sha256",
    extensions,
  });
  const fingerprint = sha256Fingerprint(pems.cert);

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    routeRequest(req, res, args).catch(() => {
      sendJson(res, 500, { error: "internal" });
    });
  });

  await new Promise<void>((resolve) => server.listen(args.port, () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("pair-server: failed to read listening address");
  }
  const port = addr.port;

  let bonjour: BonjourLike | null = null;
  if (args.mdns) {
    // bonjour-service exports the class via CJS `export =`; the default import
    // gives us the constructor under esModuleInterop.
    const inst = new Bonjour() as unknown as BonjourLike;
    inst.publish({ name: `ChainPay on ${os.hostname()}`, type: "chainpay", port });
    bonjour = inst;
  }

  serverHandle = { server, bonjour };
  return { port, certFingerprint: fingerprint, certPem: pems.cert };
}

export async function stopPairServer(): Promise<void> {
  if (!serverHandle) return;
  const { server, bonjour } = serverHandle;
  if (bonjour) {
    await new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy(() => resolve());
      });
    });
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  serverHandle = null;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  args: StartArgs,
): Promise<void> {
  const url = req.url ?? "/";
  if (req.method === "GET" && url === MOBILE_ROUTES.health) {
    sendJson(res, 200, { ok: true, app: "chainpay", version: args.appVersion });
    return;
  }
  if (req.method === "GET" && url === MOBILE_ROUTES.commPubkey) {
    sendJson(res, 200, { comm_pubkey: args.commPubkey });
    return;
  }
  if (req.method === "POST" && url === MOBILE_ROUTES.pair) {
    await handlePair(req, res);
    return;
  }
  if (req.method === "POST" && url === MOBILE_ROUTES.invoices) {
    await handleInvoices(req, res, args);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Drain any body to allow the request to complete cleanly.
  req.resume();
  // Pair handshake is wired in a later task; signal not-implemented so callers
  // don't mistake the stub for a successful pairing.
  sendJson(res, 501, { error: "not implemented" });
}

async function handleInvoices(
  req: IncomingMessage,
  res: ServerResponse,
  args: StartArgs,
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const token = auth.slice("Bearer ".length).trim();
  const verify = verifyToken({
    token,
    rootPublicKey: args.rootKeypair.publicKey,
    requiredCapability: 'write("invoices")',
    nowRfc3339: new Date().toISOString(),
  });
  if (!verify.ok || !verify.tokenId) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (await isRevoked(verify.tokenId)) {
    sendJson(res, 401, { error: "revoked" });
    return;
  }
  const device = await getDeviceByTokenId(verify.tokenId);
  if (!device) {
    sendJson(res, 401, { error: "unknown device" });
    return;
  }

  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    if (bodyResult.reason === "oversize") {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    if (bodyResult.reason === "parse") {
      sendJson(res, 400, { error: "invalid body" });
      return;
    }
    sendJson(res, 400, { error: "io" });
    return;
  }
  const parsed = MobileInvoicePayloadSchema.safeParse(bodyResult.body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "invalid payload" });
    return;
  }

  try {
    const result = await receiveMobileInvoice({
      payload: parsed.data,
      deviceLabel: device.deviceLabel,
      sendToRenderer: args.sendToRenderer,
    });
    const status = result.status === "duplicate" ? 409 : 201;
    sendJson(res, status, { invoiceId: result.invoiceId });
  } catch {
    sendJson(res, 500, { error: "dispatch failed" });
  }
}

type ReadBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "oversize" | "parse" | "io" };

async function readJsonBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let resolved = false;
    req.on("data", (c: Buffer) => {
      if (resolved) return;
      total += c.length;
      if (total > BODY_LIMIT_BYTES) {
        resolved = true;
        // Drain the rest so the request completes cleanly; the caller will respond 413.
        req.resume();
        resolve({ ok: false, reason: "oversize" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (resolved) return;
      resolved = true;
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, reason: "parse" });
      }
    });
    req.on("error", () => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, reason: "io" });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sha256Fingerprint(pem: string): string {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  const der = Buffer.from(body, "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  const pairs = hex.match(/.{2}/g);
  if (!pairs) throw new Error("sha256Fingerprint: regex match failed");
  return pairs.join(":");
}
