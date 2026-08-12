import { describe, expect, it } from "vitest";
import type { PayeeProfile } from "@chain-pay/shared";
import {
  autoLabel,
  buildBatchLinesFromRecipients,
  monthEnd,
  monthStart,
  type RecipientRow,
} from "./payment-draft";

const PAYEE: PayeeProfile = {
  id: "payee-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  displayName: "Vendor One",
  salaryFiat: { currency: "USD", minor: 250_000n },
  preferredChain: "ckb:testnet",
  preferredAsset: "CKB",
  walletAddress: "ckt1qtest",
  active: true,
};

const findPayee = (id: string): PayeeProfile | undefined => (id === PAYEE.id ? PAYEE : undefined);

describe("buildBatchLinesFromRecipients", () => {
  it("builds one line per complete payee row", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "payee-1", fxRate: "0.005" },
    ];
    const lines = buildBatchLinesFromRecipients(rows, findPayee);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      payeeId: "payee-1",
      fiat: PAYEE.salaryFiat,
      crypto: { asset: "CKB", value: 100_000_000_000n, decimals: 8 },
      fxRate: "0.005",
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    });
  });

  it("skips rows with no payee id", () => {
    const rows: RecipientRow[] = [{ address: "ckt1qa", amountCkb: "1000", fxRate: "0.005" }];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows with no fx rate", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "payee-1" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows whose payee cannot be resolved", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "ghost", fxRate: "0.005" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows whose amount does not parse", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "not-a-number", payeeId: "payee-1", fxRate: "0.005" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });
});

describe("date helpers", () => {
  // Chosen far from any month boundary so the UTC-derived label (autoLabel)
  // and the local-derived cycle bounds (monthStart/monthEnd) cannot disagree
  // across timezones — a date near the 1st/last day of the month could shift
  // to the adjacent month in UTC vs local time depending on the CI timezone.
  const NOW = new Date(2026, 1, 14); // 14 Feb 2026, local time

  it("labels a batch with the ISO date", () => {
    // Derive the expectation the same way autoLabel does (UTC slice), not a
    // hand-written string, so this assertion can't disagree with the
    // implementation's own timezone handling.
    expect(autoLabel(NOW)).toBe(`Batch ${NOW.toISOString().slice(0, 10)}`);
  });

  it("returns the first day of the current month", () => {
    expect(monthStart(NOW)).toBe("2026-02-01");
  });

  it("returns the last day of the current month", () => {
    expect(monthEnd(NOW)).toBe("2026-02-28");
  });

  it("handles a 31-day month", () => {
    expect(monthEnd(new Date(2026, 0, 5))).toBe("2026-01-31");
  });
});
