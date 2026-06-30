export type ParseRescanBlockResult =
  | { ok: true; block: bigint }
  | { ok: false; error: string };

/**
 * Validate a user-entered start block for a custom rescan. Accepts a plain
 * non-negative integer; rejects empty/non-digit/negative input and (when `tip`
 * is known) any block above the chain tip. `tip = null` skips the upper bound.
 */
export function parseRescanBlock(input: string, tip: bigint | null): ParseRescanBlockResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter a block number." };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Block must be a whole number." };
  const block = BigInt(trimmed);
  if (tip !== null && block > tip) {
    return { ok: false, error: `Block is above the current tip (${tip}).` };
  }
  return { ok: true, block };
}
