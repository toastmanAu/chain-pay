/**
 * True if `expiresAt` is set and has passed.
 *
 * `expiresAt` is epoch SECONDS (per OutgoingPacket.expiresAt). `now` is epoch
 * MILLISECONDS (Date.now()). Missing / zero expiresAt is treated as never-
 * expires — defensive for legacy packets pre-expiresAt support.
 */
export function isExpired(expiresAt: number | undefined, now: number = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  return now / 1000 > expiresAt;
}
