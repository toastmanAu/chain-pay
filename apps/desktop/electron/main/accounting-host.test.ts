import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchComplianceExport, postJournalToFrappe, saveComplianceExport } from "./accounting-host";

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
      ok: false, status: 417, text: async () => "ValidationError: secret-upstream-body",
    }));
    try {
      await postJournalToFrappe(record);
      expect.fail("request should have failed");
    } catch (caught) {
      const error = caught as Error;
      expect(error.message).toContain("417");
      expect(error.message).not.toContain("secret-upstream-body");
    }
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

  it("rejects unknown nested fields before they can cross IPC to Frappe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const malicious = structuredClone(record) as typeof record & { token?: string };
    malicious.token = "renderer-secret";
    await expect(postJournalToFrappe(malicious)).rejects.toThrow(/strict validation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts finalized BTC metadata and rejects cross-chain or nested secret fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => success });
    vi.stubGlobal("fetch", fetchMock);
    const bitcoin = {
      batchId: `bitcoin:${"41".repeat(32)}`, sourceType: "send", label: "Bitcoin payment", chain: "btc:testnet",
      txHash: "31".repeat(32), confirmedAt: "2026-08-06T02:40:00.000Z",
      lines: [{ payeeId: "vendor-btc", fiat: { currency: "USD", minor: 2599n }, crypto: { asset: "BTC", value: 900719925474n, decimals: 8 } }],
      bitcoin: { reviewDigest: "41".repeat(32), wtxid: "51".repeat(32), rawTransactionHash: "61".repeat(32), blockHeight: "9007199254740995", blockHash: "71".repeat(32), confirmations: "6", inputValueSats: "900719927474", outputValueSats: "900719926474", feeSats: "1000", feeRateSatsPerVbyte: "8.333", feePayerPolicy: "transaction_inputs", outputs: [{ vout: "0", destination: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", valueSats: "900719925474" }] },
    } as const;
    await expect(postJournalToFrappe(bitcoin)).resolves.toMatchObject({ jeName: "ACC-JV-0001" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).record.bitcoin.confirmations).toBe("6");
    await expect(postJournalToFrappe({ ...record, bitcoin: bitcoin.bitcoin })).rejects.toThrow(/strict validation/);
    await expect(postJournalToFrappe({ ...bitcoin, bitcoin: { ...bitcoin.bitcoin, token: "secret" } })).rejects.toThrow(/strict validation/);
  });
});

describe("fetchComplianceExport", () => {
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

  function response(content: Uint8Array, format: "csv" | "pdf" = "csv") {
    return {
      message: {
        filename: `chainpay-compliance-all-to-all-all-chains.${format}`,
        mime_type: format === "csv" ? "text/csv;charset=utf-8" : "application/pdf",
        bytes_base64: Buffer.from(content).toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
        row_count: 2,
      },
    };
  }

  it("sends filters only and verifies the returned CSV digest", async () => {
    const bytes = Buffer.from("\ufeffbatch_id\r\nb-1\r\n", "utf8");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response(bytes) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchComplianceExport(
      { fromDate: "2026-07-01", toDate: "2026-07-31", chain: "ckb:testnet" },
      "csv",
    );

    expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(result.rowCount).toBe(2);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({
      filters: { from_date: "2026-07-01", to_date: "2026-07-31", chain: "ckb:testnet" },
      format: "csv",
    });
    expect(init.headers.Authorization).toBe("token key:secret");
    expect(init.headers.Host).toBeUndefined();
  });

  it("accepts a valid PDF and rejects mismatched content or digest", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response(pdf, "pdf") }));
    await expect(fetchComplianceExport({}, "pdf")).resolves.toMatchObject({ rowCount: 2 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...response(pdf, "pdf"), message: { ...response(pdf, "pdf").message, sha256: "0".repeat(64) } }),
    }));
    await expect(fetchComplianceExport({}, "pdf")).rejects.toThrow(/integrity/);

    const notPdf = Buffer.from("not a pdf");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response(notPdf, "pdf") }));
    await expect(fetchComplianceExport({}, "pdf")).rejects.toThrow(/invalid PDF/);
  });

  it("rejects malformed filters before contacting Frappe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchComplianceExport({ fromDate: "2026-08-03", toDate: "2026-08-02" }, "csv"))
      .rejects.toThrow(/after/);
    await expect(fetchComplianceExport({ chain: "evm:1" } as never, "csv"))
      .rejects.toThrow(/chain/);
    await expect(fetchComplianceExport({ fromDate: "not-a-date" }, "csv"))
      .rejects.toThrow(/YYYY-MM-DD/);
    await expect(fetchComplianceExport({ fromDate: "2026-02-30" }, "csv"))
      .rejects.toThrow(/calendar date/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed server envelopes and non-2xx errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { filename: "../../escape.csv" } }),
    }));
    await expect(fetchComplianceExport({}, "csv")).rejects.toThrow(/invalid response/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "PermissionError",
    }));
    await expect(fetchComplianceExport({}, "csv")).rejects.toThrow(/403|PermissionError/);
  });

  it("writes verified bytes only after a save path is selected", async () => {
    const bytes = Buffer.from("\ufeffbatch_id\r\nb-1\r\n", "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response(bytes) }));
    const write = vi.fn().mockResolvedValue(undefined);
    const saved = await saveComplianceExport({}, "csv", {
      choosePath: vi.fn().mockResolvedValue({ canceled: false, filePath: "/tmp/report.csv" }),
      write: write as never,
    });
    expect(write).toHaveBeenCalledWith("/tmp/report.csv", bytes, { mode: 0o600 });
    expect(saved).toMatchObject({ canceled: false, filePath: "/tmp/report.csv", rowCount: 2 });
  });

  it("does not write when the native save dialog is canceled", async () => {
    const bytes = Buffer.from("\ufeffbatch_id\r\nb-1\r\n", "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response(bytes) }));
    const write = vi.fn();
    const saved = await saveComplianceExport({}, "csv", {
      choosePath: vi.fn().mockResolvedValue({ canceled: true }),
      write: write as never,
    });
    expect(saved).toEqual({ canceled: true });
    expect(write).not.toHaveBeenCalled();
  });
});
