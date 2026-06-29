/** Conservative flat fee reserve for a single-sig JoyID transfer (1 CKB). Actual
 * fee is far smaller; reserving 1 CKB keeps the pre-flight check safely pessimistic. */
export const SEND_FEE_RESERVE_SHANNONS = 100_000_000n;

export interface Affordability {
  affordable: boolean;
  shortfallShannons: bigint;
}

/** Pure: can `sourceBalance` cover the outputs total plus a fee reserve? */
export function sendAffordability(
  outputsTotalShannons: bigint,
  feeReserveShannons: bigint,
  sourceBalanceShannons: bigint,
): Affordability {
  const needed = outputsTotalShannons + feeReserveShannons;
  const shortfall = needed > sourceBalanceShannons ? needed - sourceBalanceShannons : 0n;
  return { affordable: shortfall === 0n, shortfallShannons: shortfall };
}
