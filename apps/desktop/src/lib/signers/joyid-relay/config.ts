import type { CkbNetwork } from "@/lib/light-client/network-configs";

export const POLL_INTERVAL_MS = 2000;
export const POLL_TIMEOUT_MS = 120_000;
// Self-contained data-URI logo. The phone's JoyID approval screen renders this
// directly, so there's no dependency on an externally-resolvable host — the old
// `https://chainpay.local/...` URL only resolved on the LAN via mDNS and showed
// a broken image (a trust red flag on a payment approval) from JoyID's servers
// (review M3). Kept tiny to avoid bloating the redirect URL.
export const DAPP = {
  name: "ChainPay",
  logo:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' rx='12' fill='%235b4cff'/%3E%3Ctext x='32' y='42' font-family='sans-serif' font-size='28' font-weight='700' fill='white' text-anchor='middle'%3ECP%3C/text%3E%3C/svg%3E",
} as const;

export function joyidOrigin(network: CkbNetwork): string {
  return network === "mainnet" ? "https://app.joy.id" : "https://testnet.joyid.dev";
}

export function relayBaseUrl(): string {
  const url = import.meta.env.VITE_JOYID_RELAY_URL as string | undefined;
  if (!url) {
    throw new Error(
      "JoyID relay not configured. Set VITE_JOYID_RELAY_URL to the deployed joyid-relay Worker origin.",
    );
  }
  if (!url.startsWith("https://")) {
    throw new Error("VITE_JOYID_RELAY_URL must use HTTPS");
  }
  return url.replace(/\/$/, "");
}
