import type { CkbNetwork } from "@/lib/light-client/network-configs";

export const POLL_INTERVAL_MS = 2000;
export const POLL_TIMEOUT_MS = 120_000;
export const DAPP = { name: "ChainPay", logo: "https://chainpay.local/logo.png" } as const;

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
  return url.replace(/\/$/, "");
}
