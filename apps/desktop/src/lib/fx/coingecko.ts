import type { FiatAmount, FxQuote } from "@chain-pay/shared";

/**
 * CoinGecko's id for the CKB project. Asset symbol is "CKB" but their `ids`
 * parameter expects the project slug.
 */
const COINGECKO_CKB_ID = "nervos-network";

/**
 * One round-trip to CoinGecko's free simple/price endpoint. Returns the rates
 * for each requested currency as `1 CKB = X <currency>` (matches the
 * conventional FxQuote where `base=CKB, quote=<currency>`).
 *
 * No API key, 30 req/min free tier — comfortably within payroll batch
 * cadence (one batch = one call covers all currencies in that batch).
 */
export async function fetchCkbPrices(currencies: string[]): Promise<Map<string, FxQuote>> {
  const unique = Array.from(new Set(currencies.map((c) => c.toUpperCase())));
  if (unique.length === 0) return new Map();

  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=" +
    encodeURIComponent(COINGECKO_CKB_ID) +
    "&vs_currencies=" +
    unique.map((c) => c.toLowerCase()).join(",");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { [id: string]: { [cur: string]: number } | undefined };
  const node = body[COINGECKO_CKB_ID];
  if (!node) throw new Error(`CoinGecko returned no entry for '${COINGECKO_CKB_ID}'`);

  const takenAt = Date.now();
  const out = new Map<string, FxQuote>();
  for (const cur of unique) {
    const rate = node[cur.toLowerCase()];
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) continue;
    out.set(cur, {
      base: "CKB",
      quote: cur,
      rate: String(rate),
      source: "coingecko",
      takenAt,
    });
  }
  return out;
}

/**
 * Convert a fiat amount to CKB shannons using an FxQuote, all in bigint to
 * avoid float drift. Returns the integer floor.
 *
 *   shannons = (fiatMinor × 10^ckbDecimals × 10^rateDecimals)
 *              ÷ (rateInt × 10^fiatMinorDecimals)
 *
 * `fiatMinorDecimals` defaults to 2 (cents/pence). JPY-style currencies that
 * use 1 minor unit = 1 major unit will need a different value passed in —
 * leave it explicit so callers can't get it wrong silently.
 */
export function fiatToCkbShannons(
  fiat: FiatAmount,
  fxQuote: FxQuote,
  opts: { fiatMinorDecimals?: number; ckbDecimals?: number } = {},
): bigint {
  if (fxQuote.base !== "CKB") {
    throw new Error(`FX quote must be CKB-based, got base=${fxQuote.base}`);
  }
  if (fxQuote.quote.toUpperCase() !== fiat.currency.toUpperCase()) {
    throw new Error(
      `currency mismatch: fiat is ${fiat.currency}, quote is ${fxQuote.quote}`,
    );
  }
  const ckbDecimals = opts.ckbDecimals ?? 8;
  const fiatMinorDecimals = opts.fiatMinorDecimals ?? 2;
  const { intRate, rateDecimals } = parseRate(fxQuote.rate);
  if (intRate === 0n) throw new Error("FX rate is zero — cannot convert");

  const numerator =
    fiat.minor * 10n ** BigInt(ckbDecimals) * 10n ** BigInt(rateDecimals);
  const denominator = intRate * 10n ** BigInt(fiatMinorDecimals);
  return numerator / denominator;
}

/** "0.0042" → { intRate: 42n, rateDecimals: 4 }.  "100" → { intRate: 100n, rateDecimals: 0 }. */
export function parseRate(rateStr: string): { intRate: bigint; rateDecimals: number } {
  const s = rateStr.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) {
    throw new Error(`malformed rate string: ${rateStr}`);
  }
  const dotIdx = s.indexOf(".");
  if (dotIdx === -1) return { intRate: BigInt(s), rateDecimals: 0 };
  const intPart = s.slice(0, dotIdx);
  const fracPart = s.slice(dotIdx + 1);
  return {
    intRate: BigInt(intPart + fracPart),
    rateDecimals: fracPart.length,
  };
}

/** "0.0042" → "1 CKB = 0.0042 USD" style display formatting. */
export function formatFxQuote(q: FxQuote): string {
  return `1 ${q.base} = ${q.rate} ${q.quote}`;
}
