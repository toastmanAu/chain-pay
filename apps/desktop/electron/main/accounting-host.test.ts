import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postJournalToFrappe } from "./accounting-host";

const record = {
  batchId: "b1",
  sourceType: "send",
  label: "Send b1",
  chain: "ckb:testnet",
  txHash: `0x${"ab".repeat(32)}`,
  confirmedAt: "2026-07-30T00:00:00.000Z",
  lines: [
    {
      payeeId: "p1",
      fiat: { currency: "USD", minor: 50n },
      crypto: { asset: "CKB", value: 61_00000000n, decimals: 8 },
    },
  ],
};

const success = {
  message: {
    je_name: "ACC-JV-0001",
    idempotent: false,
    record_name: "BATCH-2607-0001",
    record_idempotent: false,
  },
};

describe("postJournalToFrappe", () => {
  beforeEach(() => {
    process.env.FRAPPE_URL = "http://chainpay.localhost:8001";
    process.env.FRAPPE_API_KEY = "key";
    process.env.FRAPPE_API_SECRET = "secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FRAPPE_URL;
    delete process.env.FRAPPE_API_KEY;
    delete process.env.FRAPPE_API_SECRET;
  });

  it("POSTs to the whitelisted method and returns the parsed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => success,
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await postJournalToFrappe(record);
    expect(res).toEqual({
      jeName: "ACC-JV-0001",
      idempotent: false,
      recordName: "BATCH-2607-0001",
      recordIdempotent: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://chainpay.localhost:8001/api/method/crypto_payroll.api.post_confirmed_payment",
    );
    expect(init.headers.Authorization).toBe("token key:secret");
    // Host is NOT set manually (forbidden header); fetch derives it from the URL.
    expect(init.headers.Host).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 417, text: async () => "ValidationError: unbalanced",
    }));
    await expect(postJournalToFrappe(record)).rejects.toThrow(/417|unbalanced/);
  });

  it("throws fast when credentials are missing", async () => {
    delete process.env.FRAPPE_API_KEY;
    await expect(postJournalToFrappe(record)).rejects.toThrow(/FRAPPE_API_KEY/);
  });

  it("serializes bigint FiatAmount.minor as plain decimal strings in the POST body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => success,
    });
    vi.stubGlobal("fetch", fetchMock);
    // Must not throw (previously threw "Do not know how to serialize a BigInt")
    await expect(postJournalToFrappe(record)).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    // Plain decimal strings — NOT "200000n" — so Python int() can parse them
    expect(body.record.lines[0].fiat.minor).toBe("50");
    expect(body.record.lines[0].crypto.value).toBe("6100000000");
    expect(body.record.lines[0].account).toBeUndefined();
  });

  it("rejects a malformed success response instead of marking the send posted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { idempotent: false } }),
    }));
    await expect(postJournalToFrappe(record)).rejects.toThrow(/invalid response/);
  });
});
