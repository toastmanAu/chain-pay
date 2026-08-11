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
