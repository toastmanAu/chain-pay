import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import selfsigned from "selfsigned";
import { getSafeStorage } from "./safe-storage";
import { tlsFingerprint } from "./tls-fingerprint";

const nodeRequire = createRequire(import.meta.url);

export interface TlsCert {
  key: string;
  cert: string;
  fingerprint: string;
}

interface StoredCert {
  key: string;
  cert: string;
  schemaVersion: 1;
}

let storeFile: string | null = null;
let cache: TlsCert | null = null;
let inFlight: Promise<TlsCert> | null = null;

function defaultUserDataDir(): string {
  try {
    return nodeRequire("electron").app.getPath("userData");
  } catch {
    throw new Error("Set tls-cert-store file via _setTlsCertFileForTests when running outside Electron");
  }
}

function resolveFile(): string {
  if (storeFile) return storeFile;
  return path.join(defaultUserDataDir(), "tls-cert.enc");
}

/** Test-only: override the tls-cert-store file path. */
export function _setTlsCertFileForTests(file: string): void {
  storeFile = file;
}

/** Test-only: reset the in-memory cert cache. */
export function _resetTlsCertCacheForTests(): void {
  cache = null;
  inFlight = null;
}

function generate(): { key: string; cert: string } {
  const attrs = [{ name: "commonName", value: os.hostname() || "chainpay" }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 2, value: os.hostname() || "chainpay" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

async function readDiskCert(): Promise<StoredCert | null> {
  try {
    const buf = await fs.readFile(resolveFile());
    const json = getSafeStorage().decrypt(buf);
    return JSON.parse(json) as StoredCert;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeDiskCert(stored: StoredCert): Promise<void> {
  const target = resolveFile();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const enc = getSafeStorage().encrypt(JSON.stringify(stored));
  const tmp = target + ".tmp";
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(enc);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

export async function loadOrCreateTlsCert(): Promise<TlsCert> {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const existing = await readDiskCert();
    if (existing) {
      const result: TlsCert = {
        key: existing.key,
        cert: existing.cert,
        fingerprint: tlsFingerprint(existing.cert),
      };
      cache = result;
      return result;
    }
    const { key, cert } = generate();
    await writeDiskCert({ key, cert, schemaVersion: 1 });
    const result: TlsCert = { key, cert, fingerprint: tlsFingerprint(cert) };
    cache = result;
    return result;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function rotateTlsCert(): Promise<TlsCert> {
  // If a loadOrCreate is in flight, wait for it to settle. Whatever it produced
  // is about to be discarded — we just need the disk write to complete first.
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // Ignore; we're about to overwrite the disk anyway.
    }
  }
  const { key, cert } = generate();
  await writeDiskCert({ key, cert, schemaVersion: 1 });
  const result: TlsCert = { key, cert, fingerprint: tlsFingerprint(cert) };
  cache = result;
  return result;
}
