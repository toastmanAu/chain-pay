/**
 * On-chain amount. `value` is the smallest unit (shannons for CKB, wei for EVM).
 * Always BigInt — never float, never JS Number.
 */
export interface Money {
  asset: string;
  /** Smallest indivisible unit count. */
  value: bigint;
  /** Decimals for display purposes only. */
  decimals: number;
}

export function mkMoney(asset: string, value: bigint, decimals: number): Money {
  return { asset, value, decimals };
}

export interface FiatAmount {
  currency: string;
  /** Integer in minor units (cents, pence...). */
  minor: bigint;
}

export interface FxQuote {
  base: string;
  quote: string;
  /** Price in quote-per-base, as a string to avoid float drift. */
  rate: string;
  source: string;
  /** Epoch ms when the quote was fetched. */
  takenAt: number;
}

export function formatMoney(m: Money, opts?: { fractionDigits?: number }): string {
  const digits = opts?.fractionDigits ?? m.decimals;
  const divisor = 10n ** BigInt(m.decimals);
  const whole = m.value / divisor;
  const remainder = m.value % divisor;
  const padded = remainder.toString().padStart(m.decimals, "0");
  const fractional = digits > 0 ? `.${padded.slice(0, digits)}` : "";
  return `${whole}${fractional} ${m.asset}`;
}
