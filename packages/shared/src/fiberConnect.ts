export type FiberConnectPayload = {
  rpc_url: string;
  auth_token: string;
  cert_fingerprint?: string;
};

const scheme = "fiberconnect://";

export function createFiberConnectUri(payload: FiberConnectPayload): string {
  const normalized = normalizeFiberConnectPayload(payload);
  const json = JSON.stringify(normalized);
  return `${scheme}${base64UrlEncode(json)}`;
}

export function parseFiberConnectUri(uri: string): FiberConnectPayload {
  if (!uri.startsWith(scheme)) {
    throw new Error("FiberConnect URI must start with fiberconnect://");
  }
  const encoded = uri.slice(scheme.length);
  if (!encoded) {
    throw new Error("FiberConnect URI payload is empty");
  }
  return normalizeFiberConnectPayload(JSON.parse(base64UrlDecode(encoded)) as FiberConnectPayload);
}

export function normalizeFiberConnectPayload(payload: FiberConnectPayload): FiberConnectPayload {
  if (payload === null || typeof payload !== "object" || typeof (payload as { rpc_url?: unknown }).rpc_url !== "string") {
    throw new Error("FiberConnect rpc_url is required");
  }
  if (typeof (payload as { auth_token?: unknown }).auth_token !== "string") {
    throw new Error("FiberConnect auth_token is required");
  }
  const fingerprintRaw = (payload as { cert_fingerprint?: unknown }).cert_fingerprint;
  const rpcUrl = payload.rpc_url.trim();
  const token = payload.auth_token.trim();
  const fingerprint = typeof fingerprintRaw === "string" ? fingerprintRaw.trim() : undefined;
  if (!rpcUrl) throw new Error("FiberConnect rpc_url is required");
  if (!token) throw new Error("FiberConnect auth_token is required");
  const parsed = new URL(rpcUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("FiberConnect rpc_url must use http or https");
  }
  return {
    rpc_url: parsed.toString(),
    auth_token: token,
    ...(fingerprint ? { cert_fingerprint: fingerprint } : {}),
  };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
