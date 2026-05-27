import { mkdir, readFile, unlink, writeFile, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ipcMain, app } from "electron";

let pdfsRoot: string | null = null;

function root(): string {
  if (pdfsRoot) return pdfsRoot;
  pdfsRoot = join(app.getPath("userData"), "invoice-pdfs");
  return pdfsRoot;
}

/** Test-only: override the userData root. */
export function __resetForTest(testRoot: string): void {
  pdfsRoot = join(testRoot, "invoice-pdfs");
}

function pathFor(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
  return join(root(), sha256.slice(0, 2), `${sha256}.pdf`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function storeInvoiceFile(bytes: Uint8Array, sha256: string): Promise<string> {
  const target = pathFor(sha256);
  if (!(await exists(target))) {
    await mkdir(join(root(), sha256.slice(0, 2)), { recursive: true });
    await writeFile(target, bytes);
  }
  return pathToFileURL(target).toString();
}

export async function readInvoiceFile(fileUri: string): Promise<Uint8Array> {
  const path = resolve(fileURLToPath(fileUri));
  const normalizedRoot = resolve(root());
  if (!path.startsWith(normalizedRoot + sep)) {
    throw new Error(`refused: path outside invoice-pdfs root (${path})`);
  }
  const buf = await readFile(path);
  return new Uint8Array(buf);
}

export async function deleteInvoiceFile(fileUri: string): Promise<void> {
  const path = resolve(fileURLToPath(fileUri));
  const normalizedRoot = resolve(root());
  if (!path.startsWith(normalizedRoot + sep)) {
    throw new Error(`refused: path outside invoice-pdfs root (${path})`);
  }
  if (await exists(path)) await unlink(path);
}

export function registerInvoiceFilesIpc(): void {
  ipcMain.handle("invoice-files:store", async (_evt, bytes: Uint8Array, sha256: string) => {
    return storeInvoiceFile(bytes, sha256);
  });
  ipcMain.handle("invoice-files:read", async (_evt, fileUri: string) => {
    return readInvoiceFile(fileUri);
  });
  ipcMain.handle("invoice-files:delete", async (_evt, fileUri: string) => {
    return deleteInvoiceFile(fileUri);
  });
}
