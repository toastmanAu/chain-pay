import { describe, it, expect, vi } from "vitest";
import { RelayClient } from "./relay-client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("RelayClient", () => {
  it("createSession posts to /session and returns id + callbackUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "abc", ttl: 120 }));
    vi.stubGlobal("__VITE_JOYID_RELAY_URL__", undefined);
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test" });
    const res = await c.createSession();
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.test/session", expect.objectContaining({ method: "POST" }));
    expect(res).toEqual({ id: "abc", callbackUrl: "https://relay.test/session/abc/callback" });
  });

  it("pollSession resolves decoded data and stops polling on first hit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: null, expired: false }))
      .mockResolvedValueOnce(jsonResponse({ data: "ZW5jb2RlZA", expired: false }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test", pollIntervalMs: 1 });
    const decoded = await c.pollSession("abc");
    expect(decoded).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("buildSignUrl targets the testnet origin and embeds the challenge", () => {
    const c = new RelayClient({ network: "testnet", fetchImpl: vi.fn(), baseUrl: "https://relay.test" });
    const url = c.buildSignUrl({ callbackUrl: "https://relay.test/session/abc/callback", challenge: "0xbeef", address: "ckt1q..." });
    expect(url).toContain("testnet.joyid.dev");
    expect(url).toContain("challenge");
  });

  it("createTxSession posts to /tx-session and returns launchUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ launchUrl: "https://relay.test/tx-launch/abc" }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test" });
    const res = await c.createTxSession({
      id: "abc",
      joyidSignUrl: "https://testnet.joyid.dev/sign-message?x",
      preview: { to: [], feeCkb: "0" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay.test/tx-session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "abc",
          joyidSignUrl: "https://testnet.joyid.dev/sign-message?x",
          preview: { to: [], feeCkb: "0" },
        }),
      }),
    );
    expect(res).toEqual({ launchUrl: "https://relay.test/tx-launch/abc" });
  });

  it("pollSession rejects immediately on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test", pollIntervalMs: 1, pollTimeoutMs: 50 });
    await expect(c.pollSession("abc")).rejects.toThrow(/502/);
  });

  it("pollSession rejects when the session is expired", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: null, expired: true }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test", pollIntervalMs: 1, pollTimeoutMs: 50 });
    await expect(c.pollSession("abc")).rejects.toThrow(/expired/i);
  });

  it("createSession rejects when relay returns an id with illegal chars", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "../evil", ttl: 120 }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test" });
    await expect(c.createSession()).rejects.toThrow(/invalid session id/i);
  });
});
