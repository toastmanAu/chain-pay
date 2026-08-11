/** Whole seconds elapsed since an epoch-millisecond timestamp, clamped at zero. */
export function secondsAgo(timestampMs: number): number {
  return Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
}
