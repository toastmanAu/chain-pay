import { formatThousands } from "./thousands";

/** Renders a block/slot height with thousands separators. */
export function formatBlockNumber(n: bigint): string {
  return formatThousands(n);
}
