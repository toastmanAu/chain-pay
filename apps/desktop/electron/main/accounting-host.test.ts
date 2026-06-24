import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postJournalToFrappe } from "./accounting-host";

const preview = { batchId: "b1", entries: [] };

describe("postJournalToFrappe", () => {
  beforeEach(() => {
    process.env.FRAPPE_URL = "http://chainpay.localhost:8001";
    process.env.FRAPPE_API_KEY = "key";
    process.env.FRAPPE_API_SECRET = "secret";
  });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs to the whitelisted method and returns the parsed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { je_name: "ACC-JV-0001", idempotent: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await postJournalToFrappe("b1", preview);
    expect(res).toEqual({ jeName: "ACC-JV-0001", idempotent: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://chainpay.localhost:8001/api/method/crypto_payroll.api.post_journal");
    expect(init.headers.Authorization).toBe("token key:secret");
    // Host is NOT set manually (forbidden header); fetch derives it from the URL.
    expect(init.headers.Host).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 417, text: async () => "ValidationError: unbalanced",
    }));
    await expect(postJournalToFrappe("b1", preview)).rejects.toThrow(/417|unbalanced/);
  });

  it("throws fast when credentials are missing", async () => {
    delete process.env.FRAPPE_API_KEY;
    await expect(postJournalToFrappe("b1", preview)).rejects.toThrow(/FRAPPE_API_KEY/);
  });
});
