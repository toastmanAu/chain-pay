import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { MobileInvoicePayloadSchema, type MobileInvoicePayload } from "@chain-pay/shared";
import { storeInvoiceFile } from "./invoice-files-host";

export interface MobileInboxEntry {
  invoiceId: string;
  mobileId: string;
  capturedAt: number;
  receivedAt: string;
  sourceLabel: string;
  extraction: MobileInvoicePayload["extraction"];
  imageUri: string;
  imageSha256: string;
  imageBytes: number;
  imageMime: "image/jpeg" | "image/png";
}

let testRoot: string | null = null;
const inboxRoot = (): string => join(testRoot ?? app.getPath("userData"), "mobile-inbox");
const entryPath = (mobileId: string): string => join(inboxRoot(), `${mobileId}.json`);

/** Test-only: keep fixture writes outside the real Electron profile. */
export function __resetMobileInboxForTest(root: string): void {
  testRoot = root;
}

async function readEntry(mobileId: string): Promise<MobileInboxEntry | null> {
  try {
    return JSON.parse(await readFile(entryPath(mobileId), "utf8")) as MobileInboxEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listMobileInbox(): Promise<MobileInboxEntry[]> {
  let names: string[];
  try {
    names = (await readdir(inboxRoot())).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.sort().map(async (name) =>
    JSON.parse(await readFile(join(inboxRoot(), name), "utf8")) as MobileInboxEntry,
  ));
}

/** Store the image and a complete metadata file before returning an HTTP ACK. */
export async function persistMobileInvoice(
  input: MobileInvoicePayload,
  sourceLabel: string,
): Promise<{ status: "created" | "duplicate"; entry: MobileInboxEntry }> {
  const payload = MobileInvoicePayloadSchema.parse(input);
  const existing = await readEntry(payload.id);
  if (existing) return { status: "duplicate", entry: existing };

  const image = Buffer.concat(payload.image_chunks.map((chunk) => Buffer.from(chunk, "base64")));
  if (image.length === 0) throw new Error("empty image");
  const imageSha256 = createHash("sha256").update(image).digest("hex");
  const imageUri = await storeInvoiceFile(image, imageSha256);
  const entry: MobileInboxEntry = {
    invoiceId: `inv_${payload.id.toLowerCase()}`,
    mobileId: payload.id,
    capturedAt: payload.capturedAt,
    receivedAt: new Date().toISOString(),
    sourceLabel: sourceLabel.slice(0, 64),
    extraction: payload.extraction,
    imageUri,
    imageSha256,
    imageBytes: image.length,
    imageMime: payload.image_mime,
  };

  await mkdir(inboxRoot(), { recursive: true });
  const temporary = join(inboxRoot(), `${payload.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
    await link(temporary, entryPath(payload.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readEntry(payload.id);
    if (!winner) throw error;
    return { status: "duplicate", entry: winner };
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return { status: "created", entry };
}
