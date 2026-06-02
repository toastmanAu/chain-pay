import { MOBILE_ROUTES, type MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";

export type IpSendResult =
  | { ok: true; status: "created" | "duplicate"; invoiceId: string }
  | { ok: false; kind: "unauthorized" | "client" | "server" | "network"; detail?: string };

export async function sendInvoiceViaIp(args: {
  pairing: PairingPayload;
  payload: MobileInvoicePayload;
}): Promise<IpSendResult> {
  const url = new URL(MOBILE_ROUTES.invoices, args.pairing.rpc_url).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.pairing.auth_token}`,
      },
      body: JSON.stringify(args.payload),
    });
    if (res.status === 201) {
      const j = (await res.json()) as { invoiceId?: unknown };
      if (typeof j.invoiceId !== "string") {
        return { ok: false, kind: "client", detail: "missing invoiceId in 201 response" };
      }
      return { ok: true, status: "created", invoiceId: j.invoiceId };
    }
    if (res.status === 409) {
      const j = (await res.json()) as { invoiceId?: unknown };
      if (typeof j.invoiceId !== "string") {
        return { ok: false, kind: "client", detail: "missing invoiceId in 409 response" };
      }
      return { ok: true, status: "duplicate", invoiceId: j.invoiceId };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "unauthorized" };
    }
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, kind: "client", detail: await res.text() };
    }
    return { ok: false, kind: "server", detail: await res.text() };
  } catch (e) {
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function healthCheck(pairing: PairingPayload): Promise<boolean> {
  try {
    const url = new URL(MOBILE_ROUTES.health, pairing.rpc_url).toString();
    const res = await fetch(url, { method: "GET" });
    if (res.status !== 200) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

export async function fetchCommPubkey(pairing: PairingPayload): Promise<string | null> {
  try {
    const url = new URL(MOBILE_ROUTES.commPubkey, pairing.rpc_url).toString();
    const res = await fetch(url, { method: "GET" });
    if (res.status !== 200) return null;
    const j = (await res.json()) as { comm_pubkey?: unknown };
    if (typeof j.comm_pubkey !== "string") return null;
    return j.comm_pubkey;
  } catch {
    return null;
  }
}
