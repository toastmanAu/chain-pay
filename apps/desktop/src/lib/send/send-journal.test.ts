import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendRecord } from "@chain-pay/shared";
import { useSendsStore } from "@/stores/sends";

const { postJournal } = vi.hoisted(() => ({ postJournal: vi.fn() }));
vi.mock("@/lib/accounting/ipc", () => ({ postJournal }));

import {
  buildSendJournal,
  buildConfirmedSendRecord,
  DEFAULT_SEND_ACCOUNT_MAP,
  postSendJournal,
} from "./send-journal";

function confirmedSend(): SendRecord {
  return {
    id: "snd1",
    sourceId: "src1",
    chain: "ckb:testnet",
    outputs: [
      {
        payeeId: "vendor-1",
        payeeAddress: "ckt1qpayee",
        amount: { asset: "CKB", value: 7_000_000_000n, decimals: 8 },
        fiat: { currency: "AUD", minor: 10000n },
      },
    ],
    feeShannons: 120000n,
    state: "confirmed",
    txHash: `0x${"ab".repeat(32)}`,
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

describe("buildSendJournal", () => {
  it("builds an immutable source record without client-selected ledger accounts", () => {
    const record = buildConfirmedSendRecord(confirmedSend());
    expect(record).toMatchObject({
      batchId: "snd1",
      sourceType: "send",
      chain: "ckb:testnet",
      lines: [{ payeeId: "vendor-1", fiat: { currency: "AUD", minor: 10000n } }],
    });
    expect(JSON.stringify(record, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("Salary or Wage Expense");
  });

  it("produces a balanced zero-FX journal (debit expense, credit treasury)", () => {
    const preview = buildSendJournal(confirmedSend(), DEFAULT_SEND_ACCOUNT_MAP);
    expect(preview.batchId).toBe("snd1");
    const debit = preview.entries.find((e) => e.debit && e.account === DEFAULT_SEND_ACCOUNT_MAP.expense);
    const credit = preview.entries.find((e) => e.credit && e.account === DEFAULT_SEND_ACCOUNT_MAP.treasury);
    expect(debit?.debit?.minor).toBe(10000n);
    expect(credit?.credit?.minor).toBe(10000n);
    // zero-FX: no FX gain/loss line
    expect(preview.entries.some((e) => e.account === DEFAULT_SEND_ACCOUNT_MAP.fxGainLoss)).toBe(false);
  });

  it("throws when the send has no txHash", () => {
    const s = confirmedSend();
    delete s.txHash;
    expect(() => buildSendJournal(s, DEFAULT_SEND_ACCOUNT_MAP)).toThrow(/no txHash/);
  });

  it("rejects a zero fiat valuation before contacting Frappe", () => {
    const s = confirmedSend();
    s.outputs[0]!.fiat.minor = 0n;
    expect(() => buildSendJournal(s, DEFAULT_SEND_ACCOUNT_MAP)).toThrow(
      /Accounting fiat value is required/,
    );
  });

  it("all journal entry memos start with 'Send ' (not 'Payroll')", () => {
    const preview = buildSendJournal(confirmedSend(), DEFAULT_SEND_ACCOUNT_MAP);
    const memos = preview.entries.map((e) => e.memo);
    expect(memos.every((m) => m?.startsWith("Send "))).toBe(true);
  });
});

describe("postSendJournal recovery", () => {
  beforeEach(() => {
    postJournal.mockReset();
    useSendsStore.setState({ sends: [] });
  });

  it("retries a committed post_failed send through accounting only and preserves its txHash", async () => {
    const send = confirmedSend();
    send.state = "post_failed";
    send.postError = "FRAPPE_URL not configured";
    useSendsStore.setState({ sends: [send] });
    postJournal.mockResolvedValue({ jeName: "ACC-JV-RECOVERED", idempotent: false });

    await postSendJournal(send.id);

    expect(postJournal).toHaveBeenCalledTimes(1);
    expect(postJournal).toHaveBeenCalledWith(expect.objectContaining({ batchId: send.id }));
    const recovered = useSendsStore.getState().sends[0]!;
    expect(recovered.state).toBe("posted");
    expect(recovered.txHash).toBe(send.txHash);
    expect(recovered.journalEntryName).toBe("ACC-JV-RECOVERED");
    expect(recovered.postError).toBeUndefined();
  });

  it("coalesces concurrent Retry clicks into one idempotent Frappe POST", async () => {
    const send = confirmedSend();
    send.state = "post_failed";
    useSendsStore.setState({ sends: [send] });

    let resolvePost!: (value: { jeName: string; idempotent: boolean }) => void;
    postJournal.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    const first = postSendJournal(send.id);
    const second = postSendJournal(send.id);
    expect(second).toBe(first);
    expect(postJournal).toHaveBeenCalledTimes(1);

    resolvePost({ jeName: "ACC-JV-EXISTING", idempotent: true });
    await Promise.all([first, second]);
    expect(useSendsStore.getState().sends[0]).toMatchObject({
      state: "posted",
      journalEntryName: "ACC-JV-EXISTING",
      txHash: send.txHash,
    });
  });

  it("records an accounting error without losing the committed transaction identity", async () => {
    const send = confirmedSend();
    useSendsStore.setState({ sends: [send] });
    postJournal.mockRejectedValue(new Error("Frappe 503"));

    await postSendJournal(send.id);

    expect(useSendsStore.getState().sends[0]).toMatchObject({
      state: "post_failed",
      postError: "Frappe 503",
      txHash: send.txHash,
    });
  });
});
