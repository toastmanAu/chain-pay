// apps/desktop/src/lib/send/affordability.test.ts
import { describe, it, expect } from "vitest";
import {
  sendAffordability,
  SEND_FEE_RESERVE_SHANNONS,
} from "./affordability";

describe("sendAffordability", () => {
  it("returns affordable=true and shortfall=0n when balance > outputs + reserve", () => {
    // 200 CKB balance, 61 CKB output, 1 CKB reserve → 138 CKB surplus
    const outputsTotal = 6_100_000_000n; // 61 CKB
    const feeReserve = SEND_FEE_RESERVE_SHANNONS; // 1 CKB = 100_000_000n
    const balance = 20_000_000_000n; // 200 CKB
    const result = sendAffordability(outputsTotal, feeReserve, balance);
    expect(result.affordable).toBe(true);
    expect(result.shortfallShannons === 0n).toBe(true);
  });

  it("returns affordable=true and shortfall=0n at exact boundary (balance === outputs + reserve)", () => {
    // balance exactly covers outputs + reserve
    const outputsTotal = 6_100_000_000n; // 61 CKB
    const feeReserve = SEND_FEE_RESERVE_SHANNONS; // 1 CKB
    const balance = outputsTotal + feeReserve; // exactly 62 CKB
    const result = sendAffordability(outputsTotal, feeReserve, balance);
    expect(result.affordable).toBe(true);
    expect(result.shortfallShannons === 0n).toBe(true);
  });

  it("returns affordable=false and exact shortfall when balance < outputs + reserve", () => {
    // 61 CKB balance, 61 CKB output + 1 CKB reserve = need 62 CKB, short by 1 CKB
    const outputsTotal = 6_100_000_000n; // 61 CKB
    const feeReserve = SEND_FEE_RESERVE_SHANNONS; // 1 CKB = 100_000_000n
    const balance = 6_100_000_000n; // only 61 CKB
    const expectedShortfall = outputsTotal + feeReserve - balance; // 100_000_000n = 1 CKB
    const result = sendAffordability(outputsTotal, feeReserve, balance);
    expect(result.affordable).toBe(false);
    expect(result.shortfallShannons === expectedShortfall).toBe(true);
  });
});
