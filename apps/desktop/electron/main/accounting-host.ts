import { ipcMain } from "electron";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured (Frappe accounting bridge)`);
  return v;
}

/**
 * POST an AccountingJournalPreview to the whitelisted Frappe endpoint.
 * Credentials live only here in the main process. Throws on any failure so the
 * renderer's postBatchJournal can transition the batch to post_failed.
 */
export async function postJournalToFrappe(
  batchId: string,
  preview: unknown,
): Promise<PostJournalResult> {
  const base = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const res = await fetch(`${base}/api/method/crypto_payroll.api.post_journal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${key}:${secret}`,
    },
    // Slice B gotcha #1: Frappe routes by Host header. We do NOT set Host
    // manually (fetch/undici treats it as a forbidden header). Instead FRAPPE_URL
    // MUST be the site host (http://chainpay.localhost:PORT), so fetch derives the
    // correct Host automatically. chainpay.localhost resolves to 127.0.0.1 on the
    // host where Electron main runs.
    body: JSON.stringify({ batch_id: batchId, preview }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Frappe post_journal failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { message: { je_name: string; idempotent: boolean } };
  return { jeName: body.message.je_name, idempotent: body.message.idempotent };
}

export function registerAccountingIpc(): void {
  ipcMain.handle("accounting:postJournal", async (_evt, batchId: string, preview: unknown) => {
    return postJournalToFrappe(batchId, preview);
  });
}
