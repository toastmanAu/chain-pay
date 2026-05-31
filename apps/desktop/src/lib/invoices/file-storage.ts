/** Compute SHA-256 of a Blob using Web Crypto. Returns 64-char lowercase hex. */
export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash + store. Returns content-addressed file:// URI and the sha256. */
export async function storeBlob(blob: Blob): Promise<{ uri: string; sha256: string }> {
  const sha256 = await hashBlob(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const uri = await window.chainpay.invoiceFiles.store(bytes, sha256);
  return { uri, sha256 };
}

/** Read bytes for a previously-stored URI. */
export async function readUri(uri: string): Promise<Uint8Array> {
  return window.chainpay.invoiceFiles.read(uri);
}

/** Delete the stored file. No-op if absent. */
export async function deleteUri(uri: string): Promise<void> {
  return window.chainpay.invoiceFiles.delete(uri);
}

/**
 * Read a previously-stored file URI back as a Blob.
 * Returns null if the IPC call fails (e.g. file deleted).
 */
export async function fileFromStorage(uri: string): Promise<Blob | null> {
  try {
    const bytes = await readUri(uri);
    // Copy into a plain ArrayBuffer to satisfy the Blob constructor's BlobPart
    // type constraint (Uint8Array's .buffer may be typed as ArrayBufferLike).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Blob([ab], { type: "application/pdf" });
  } catch {
    return null;
  }
}
