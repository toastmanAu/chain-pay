import fs from "node:fs/promises";
import path from "node:path";
import { getSafeStorage } from "./safe-storage";

export interface PlainIdentity {
  mlDsaSec: Uint8Array;
  mlKemSec: Uint8Array;
  mlDsaPub: Uint8Array;
  mlKemPub: Uint8Array;
  address: string;
  /** 20-byte hash from the ck-mldsa-lock address args. */
  addrHash: Uint8Array;
  createdAt: number;
}

export interface PublicIdentity {
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  /** 0x-prefixed 20-byte hex of address args. */
  addrHash: string;
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron").app.getPath("userData");
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
    createdAt: json.createdAt,
  };
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const shape: StoredShape = {
    mlDsaSec: toHex(identity.mlDsaSec),
    mlKemSec: toHex(identity.mlKemSec),
    mlDsaPub: toHex(identity.mlDsaPub),
    mlKemPub: toHex(identity.mlKemPub),
    address: identity.address,
    addrHash: toHex(identity.addrHash),
    createdAt: identity.createdAt,
  };
  const encrypted = getSafeStorage().encrypt(JSON.stringify(shape));
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, encrypted);
  await fs.rename(tmp, file);
}

export async function deleteCommIdentity(): Promise<void> {
  const file = resolveIdentityFile();
  await fs.rm(file, { force: true });
}

export async function withSecrets<T>(
  use: (secrets: { mlDsaSec: Uint8Array; mlKemSec: Uint8Array }) => Promise<T>,
): Promise<T> {
  const file = resolveIdentityFile();
  const raw = await fs.readFile(file);
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  const mlDsaSec = fromHex(json.mlDsaSec);
  const mlKemSec = fromHex(json.mlKemSec);
  try {
    return await use({ mlDsaSec, mlKemSec });
  } finally {
    mlDsaSec.fill(0);
    mlKemSec.fill(0);
  }
}
