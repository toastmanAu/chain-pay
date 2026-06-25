// apps/desktop/src/lib/send/ckb-amount.ts
// Pure integer (bigint) helpers for CKB ↔ shannon conversion.
// No parseFloat, no Number(), no floating-point arithmetic — exact for all
// treasury balances, including values beyond Number.MAX_SAFE_INTEGER.

const SHANNONS_PER_CKB = 100_000_000n;
const FRAC_DIGITS = 8;

/**
 * Parse a user-supplied CKB string (e.g. "70", "70.5", "0.00000001") to
 * shannons using integer arithmetic only.
 *
 * Returns null for:
 *   - empty or whitespace-only input
 *   - non-numeric input
 *   - negative values
 *   - more than 8 fractional digits
 */
export function ckbStringToShannons(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Reject negatives
  if (trimmed.startsWith("-")) return null;

  // Split on the decimal point — at most one allowed
  const dotIndex = trimmed.indexOf(".");
  const wholeStr = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const fracStr = dotIndex === -1 ? "" : trimmed.slice(dotIndex + 1);

  // Reject multiple dots
  if (fracStr.includes(".")) return null;

  // Validate: whole part must be all digits (non-empty)
  if (wholeStr === "" || !/^\d+$/.test(wholeStr)) return null;

  // Validate: fractional part must be all digits
  if (fracStr !== "" && !/^\d+$/.test(fracStr)) return null;

  // Reject more than 8 fractional digits
  if (fracStr.length > FRAC_DIGITS) return null;

  // Pad fractional part to exactly 8 digits (right-pad with zeros)
  const fracPadded = fracStr.padEnd(FRAC_DIGITS, "0");

  const whole = BigInt(wholeStr);
  const frac = BigInt(fracPadded);

  return whole * SHANNONS_PER_CKB + frac;
}

/**
 * Format shannons to a CKB decimal string using integer/remainder arithmetic.
 *
 * Examples:
 *   7_000_000_000n → "70"
 *   7_050_000_000n → "70.5"
 *   1n             → "0.00000001"
 *   0n             → "0"
 *
 * Negative values are handled gracefully (sign is preserved) even though they
 * should never appear in practice.
 */
export function shannonsToCkbString(shannons: bigint): string {
  const negative = shannons < 0n;
  const abs = negative ? -shannons : shannons;

  const whole = abs / SHANNONS_PER_CKB;
  const frac = abs % SHANNONS_PER_CKB;

  if (frac === 0n) {
    return (negative ? "-" : "") + whole.toString();
  }

  // Pad the fractional part to 8 digits, then strip trailing zeros
  const fracStr = frac.toString().padStart(FRAC_DIGITS, "0").replace(/0+$/, "");

  return (negative ? "-" : "") + whole.toString() + "." + fracStr;
}
