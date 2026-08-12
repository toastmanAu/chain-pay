import { formatThousands } from "./thousands";

export function formatSol(lamportText: string): string {
  const lamports = BigInt(lamportText);
  const whole = lamports / 1_000_000_000n;
  const fractional = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${formatThousands(whole)}.${fractional}` : formatThousands(whole);
}

export function formatSignedSol(lamportText: string): string {
  const lamports = BigInt(lamportText);
  return lamports < 0n ? `-${formatSol((-lamports).toString())}` : `+${formatSol(lamports.toString())}`;
}

export function formatLamports(lamportText: string): string {
  return formatThousands(BigInt(lamportText));
}
