import { ipcMain } from "electron";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
  recordName: string;
  recordIdempotent: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured (Frappe accounting bridge)`);
  return v;
}

/**
 * POST a confirmed domain payment record to the whitelisted Frappe endpoint.
 * Credentials live only here in the main process. Throws on any failure so the
 * renderer can transition the payment to post_failed. GL accounts are not part
 * of this contract; Frappe owns account selection and Journal Entry derivation.
 */
export async function postJournalToFrappe(
  record: unknown,
): Promise<PostJournalResult> {
  const base = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const res = await fetch(`${base}/api/method/crypto_payroll.api.post_confirmed_payment`, {
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
    body: JSON.stringify(
      { record },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    ),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Frappe post_confirmed_payment failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  const body = (await res.json()) as {
    message?: {
      je_name?: unknown;
      idempotent?: unknown;
      record_name?: unknown;
      record_idempotent?: unknown;
    };
  };
  if (
    typeof body.message?.je_name !== "string" ||
    body.message.je_name.length === 0 ||
    typeof body.message.idempotent !== "boolean" ||
    typeof body.message.record_name !== "string" ||
    body.message.record_name.length === 0 ||
    typeof body.message.record_idempotent !== "boolean"
  ) {
    throw new Error("Frappe post_confirmed_payment returned an invalid response");
  }
  return {
    jeName: body.message.je_name,
    idempotent: body.message.idempotent,
    recordName: body.message.record_name,
    recordIdempotent: body.message.record_idempotent,
  };
}

export function registerAccountingIpc(): void {
  ipcMain.handle("accounting:postJournal", async (_evt, record: unknown) => {
    return postJournalToFrappe(record);
  });
}
