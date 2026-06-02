import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getSafeStorage } from "./safe-storage";

const nodeRequire = createRequire(import.meta.url);

export interface PairedDevice {
  tokenId: string;
  deviceLabel: string;
  commPubkey: string;
  capabilities: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

interface StoreShape {
  devices: PairedDevice[];
  schemaVersion: 1;
}

let storeFile: string | null = null;

function defaultUserDataDir(): string {
  try {
    return nodeRequire("electron").app.getPath("userData");
  } catch {
    throw new Error("Set pair-store file via _setPairStoreFileForTests when running outside Electron");
  }
}

function resolveFile(): string {
  if (storeFile) return storeFile;
  return path.join(defaultUserDataDir(), "paired-devices.enc");
}

/** Test-only: override the pair-store file path. */
export function _setPairStoreFileForTests(file: string): void {
  storeFile = file;
}

async function readStore(): Promise<StoreShape> {
  try {
    const buf = await fs.readFile(resolveFile());
    const json = getSafeStorage().decrypt(buf);
    return JSON.parse(json) as StoreShape;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { devices: [], schemaVersion: 1 };
    }
    throw err;
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const file = resolveFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const encrypted = getSafeStorage().encrypt(JSON.stringify(store));
  const tmp = file + ".tmp";
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(encrypted);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

export async function listDevices(): Promise<PairedDevice[]> {
  return (await readStore()).devices;
}

export async function addDevice(d: PairedDevice): Promise<void> {
  const store = await readStore();
  const next: StoreShape = {
    ...store,
    devices: [...store.devices.filter((x) => x.tokenId !== d.tokenId), d],
  };
  await writeStore(next);
}

export async function revokeDevice(tokenId: string): Promise<void> {
  const store = await readStore();
  const next: StoreShape = {
    ...store,
    devices: store.devices.map((d) =>
      d.tokenId === tokenId ? { ...d, revokedAt: Date.now() } : d,
    ),
  };
  await writeStore(next);
}

export async function isRevoked(tokenId: string): Promise<boolean> {
  const store = await readStore();
  const d = store.devices.find((x) => x.tokenId === tokenId);
  return d?.revokedAt !== undefined;
}

export async function getDeviceByTokenId(tokenId: string): Promise<PairedDevice | undefined> {
  return (await readStore()).devices.find((d) => d.tokenId === tokenId);
}
