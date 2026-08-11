import { formatThousands } from "./thousands";

export function formatBtc(satoshiText: string): string {
  const sats = BigInt(satoshiText);
  const whole = sats / 100_000_000n;
  const fractional = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fractional ? `${formatThousands(whole)}.${fractional}` : formatThousands(whole);
}

export function formatSignedBtc(satoshiText: string): string {
  const sats = BigInt(satoshiText);
  if (sats < 0n) return `-${formatBtc((-sats).toString())}`;
  return `+${formatBtc(sats.toString())}`;
}
