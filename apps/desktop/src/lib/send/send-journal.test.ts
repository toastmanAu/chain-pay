import { describe, it, expect } from "vitest";
import type { SendRecord } from "@chain-pay/shared";
import { buildSendJournal, DEFAULT_SEND_ACCOUNT_MAP } from "./send-journal";

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
    txHash: "0xabc123def4567890",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

describe("buildSendJournal", () => {
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
});
