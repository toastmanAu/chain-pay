import { formatEther } from "viem";

export function formatEth(wei: bigint): string {
  const value = formatEther(wei);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}
