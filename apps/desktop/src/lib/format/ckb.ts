import { formatThousands } from "./thousands";

const SHANNONS_PER_CKB = 100_000_000n;

/**
 * Display-only: renders shannons for humans WITH thousands separators
 * (e.g. `1,234.5`). Never write this into a form field that gets re-parsed —
 * `ckbToShannons` in `lib/chains/ckb/units.ts` rejects commas and returns
 * `null`. Use `toCkbInputValue` for that instead.
 */
export function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  if (fractional === 0n) return formatThousands(whole);
  // Trim trailing zeros from the 8-digit fractional part for readability.
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${formatThousands(whole)}.${fracStr}`;
}
