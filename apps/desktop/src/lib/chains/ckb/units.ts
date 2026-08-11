export const SHANNONS_PER_CKB = 100_000_000n;

export function ckbToShannons(amountCkb: string): bigint | null {
  const trimmed = amountCkb.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = BigInt(wholeStr || "0");
  const fracPadded = (fracStr + "00000000").slice(0, 8);
  const frac = BigInt(fracPadded);
  const total = whole * SHANNONS_PER_CKB + frac;
  if (total <= 0n) return null;
  return total;
}

/**
 * Inverse of {@link ckbToShannons}: serialises shannons into the plain
 * decimal string that function accepts back (no thousands separators).
 *
 * This is for **form fields** that get re-parsed by `ckbToShannons`, not for
 * human display — `ckbToShannons`'s regex (`/^\d+(\.\d+)?$/`) rejects commas,
 * so its output must never be run through a display formatter first. For
 * rendering to a human, use `formatCkb` in `lib/format/ckb.ts` instead.
 */
export function toCkbInputValue(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const frac = (shannons % SHANNONS_PER_CKB).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}
