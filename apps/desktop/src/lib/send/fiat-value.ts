/** Parse a two-decimal fiat major-unit string into exact minor units. */
export function parseFiatMajorToMinor(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return whole * 100n + BigInt(fraction || "0");
}

/** Format exact fiat minor units without converting through an unsafe Number. */
export function formatFiatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
