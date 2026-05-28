import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getSafeStorage } from "./safe-storage";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

const nodeRequire = createRequire(import.meta.url);

export interface PlainIdentity {
  mlDsaSec: Uint8Array;
  mlKemSec: Uint8Array;
  mlDsaPub: Uint8Array;
  mlKemPub: Uint8Array;
  address: string;
  /** 20-byte hash from the ck-mldsa-lock address args. */
  addrHash: Uint8Array;
  createdAt: number;
  /** Networks on which a Profile Cell has been successfully published. */
  publishedOn?: CkbNetwork[];
}

export interface PublicIdentity {
  mlDsaPub: string;
  mlKemPub: string;
  /** Deprecated — mirrors addresses.testnet. Kept for backward-compat with renderer. */
  address: string;
  /** 0x-prefixed 20-byte hex of address args. */
  addrHash: string;
  addresses: {
    testnet: string;
    mainnet: string | null;
  };
  publishedOn: CkbNetwork[];
  createdAt: number;
}

let identityFile: string | null = null;

function resolveIdentityFile(): string {
  if (identityFile) return identityFile;
  const dir = process.env.COMM_IDENTITY_DIR ?? defaultUserDataDir();
  return path.join(dir, "comm-identity.enc");
}

function defaultUserDataDir(): string {
  // Lazy require so this file is importable outside Electron (smoke).
  try {
    return nodeRequire("electron").app.getPath("userData");
  } catch {
    throw new Error("Set COMM_IDENTITY_DIR when running outside Electron");
  }
}

/** Test-only: override the identity file path. */
export function _setIdentityFileForTests(p: string): void {
  identityFile = p;
}

function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface StoredShape {
  mlDsaSec: string;
  mlKemSec: string;
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  addrHash: string;
  createdAt: number;
  publishedOn?: CkbNetwork[];
}

export async function loadCommIdentity(): Promise<PublicIdentity | null> {
  const file = resolveIdentityFile();
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  return {
    mlDsaPub: json.mlDsaPub,
    mlKemPub: json.mlKemPub,
    address: json.address,
    addrHash: json.addrHash,
    // addresses is augmented by publicInfo() in the service with fresh derivation;
    // here we return a placeholder so the shape is always complete.
    addresses: { testnet: json.address, mainnet: null },
    publishedOn: json.publishedOn ?? [],
    createdAt: json.createdAt,
  };
}

function buildShape(identity: PlainIdentity): StoredShape {
  return {
    mlDsaSec: toHex(identity.mlDsaSec),
    mlKemSec: toHex(identity.mlKemSec),
    mlDsaPub: toHex(identity.mlDsaPub),
    mlKemPub: toHex(identity.mlKemPub),
    address: identity.address,
    addrHash: toHex(identity.addrHash),
    createdAt: identity.createdAt,
    publishedOn: identity.publishedOn ?? [],
  };
}

async function writeEncrypted(file: string, shape: StoredShape): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const encrypted = getSafeStorage().encrypt(JSON.stringify(shape));
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, encrypted);
  await fs.rename(tmp, file);
}

export async function saveCommIdentity(identity: PlainIdentity): Promise<void> {
  const file = resolveIdentityFile();
  let exists = false;
  try {
    await fs.access(file);
    exists = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (exists) {
    throw new Error("comm identity already exists; call deleteCommIdentity() first");
  }
  await writeEncrypted(file, buildShape(identity));
}

/**
 * Overwrite specific mutable fields of the stored identity without requiring
 * a delete-then-recreate cycle. Only updates `publishedOn` for now.
 * Callers must hold the full PlainIdentity (read via withSecretsRaw).
 */
export async function updateCommIdentity(
  patch: Pick<PlainIdentity, "publishedOn">,
): Promise<void> {
  const file = resolveIdentityFile();
  const raw = await fs.readFile(file);
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  const updated: StoredShape = {
    ...json,
    publishedOn: patch.publishedOn ?? [],
  };
  await writeEncrypted(file, updated);
}

export async function deleteCommIdentity(): Promise<void> {
  const file = resolveIdentityFile();
  await fs.rm(file, { force: true });
}

export interface SecretsPayload {
  mlDsaSec: Uint8Array;
  mlKemSec: Uint8Array;
  publishedOn: CkbNetwork[];
}

export async function withSecrets<T>(
  use: (secrets: SecretsPayload) => Promise<T>,
): Promise<T> {
  const file = resolveIdentityFile();
  const raw = await fs.readFile(file);
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  const mlDsaSec = fromHex(json.mlDsaSec);
  const mlKemSec = fromHex(json.mlKemSec);
  try {
    return await use({ mlDsaSec, mlKemSec, publishedOn: json.publishedOn ?? [] });
  } finally {
    mlDsaSec.fill(0);
    mlKemSec.fill(0);
  }
}
