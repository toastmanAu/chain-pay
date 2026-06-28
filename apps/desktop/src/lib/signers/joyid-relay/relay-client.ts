import { buildJoyIDURL, buildJoyIDSignMessageURL, decodeSearch } from "@joyid/common";
import type { CkbNetwork } from "@/lib/light-client/network-configs";
import { DAPP, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, joyidOrigin, relayBaseUrl } from "./config";

interface RelayClientOpts {
  network: CkbNetwork;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class RelayClient {
  private readonly network: CkbNetwork;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(opts: RelayClientOpts) {
    this.network = opts.network;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? relayBaseUrl()).replace(/\/$/, "");
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async createSession(): Promise<{ id: string; callbackUrl: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/session`, { method: "POST" });
    if (!res.ok) throw new Error(`relay /session failed: ${res.status}`);
    const body = (await res.json()) as { id: string };
    return { id: body.id, callbackUrl: `${this.baseUrl}/session/${body.id}/callback` };
  }

  async createTxSession(args: { id: string; joyidSignUrl: string; preview: unknown }): Promise<{ launchUrl: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/tx-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`relay /tx-session failed: ${res.status}`);
    return (await res.json()) as { launchUrl: string };
  }

  async pollSession(id: string): Promise<unknown> {
    const deadline = this.pollTimeoutMs;
    let waited = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.fetchImpl(`${this.baseUrl}/session/${id}`);
      if (res.ok) {
        const body = (await res.json()) as { data: string | null; expired?: boolean };
        if (body.expired) throw new Error("JoyID session expired");
        if (body.data) return decodeSearch(body.data);
      }
      waited += this.pollIntervalMs;
      if (waited >= deadline) throw new Error("JoyID session timed out (no phone response)");
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  buildAuthUrl(callbackUrl: string): string {
    return buildJoyIDURL(
      { redirectURL: callbackUrl, name: DAPP.name, logo: DAPP.logo, joyidAppURL: joyidOrigin(this.network) },
      "redirect",
      "/auth",
    );
  }

  buildSignUrl(args: { callbackUrl: string; challenge: string; address: string }): string {
    return buildJoyIDSignMessageURL(
      {
        redirectURL: args.callbackUrl,
        name: DAPP.name,
        logo: DAPP.logo,
        joyidAppURL: joyidOrigin(this.network),
        challenge: args.challenge,
        isData: false,
        address: args.address,
      },
      "redirect",
    );
  }
}
