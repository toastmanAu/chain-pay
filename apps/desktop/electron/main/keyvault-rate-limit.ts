/**
 * Keyvault rate limiter — bounds brute-force password guessing on the
 * decryption IPC channels (sign-tx, unlock-derive, export, change-password).
 *
 * Argon2id makes each guess cost ~200-500ms, but a compromised renderer could
 * still grind a weak password over time. After `maxAttempts` consecutive wrong
 * passwords for a given vault, further attempts are refused for an
 * exponentially growing window (capped at `maxDelayMs`). A correct password
 * resets the counter.
 *
 * State is in-memory in the main process — the renderer cannot reach or reset
 * it. The clock is injectable so backoff windows are deterministic in tests.
 */

interface RateLimitState {
  /** Consecutive failed attempts since the last success. */
  failures: number;
  /** Epoch ms before which `check()` refuses; 0 ⇒ not locked. */
  lockedUntil: number;
}

export interface KeyvaultRateLimiterOptions {
  /** Consecutive failures tolerated before lockout begins (default 5). */
  maxAttempts?: number;
  /** Lockout window for the first over-threshold failure, ms (default 30_000). */
  baseDelayMs?: number;
  /** Upper bound on the lockout window, ms (default 600_000 = 10 min). */
  maxDelayMs?: number;
  /** Clock source — injectable for deterministic tests. */
  now?: () => number;
}

export class KeyvaultRateLimiter {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, RateLimitState>();

  constructor(opts: KeyvaultRateLimiterOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 30_000;
    this.maxDelayMs = opts.maxDelayMs ?? 600_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Throws if the vault is currently locked out. Call before any decrypt. */
  check(vaultId: string): void {
    const state = this.states.get(vaultId);
    if (!state) return;
    const remaining = state.lockedUntil - this.now();
    if (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      throw new Error(
        `Too many failed password attempts. Locked for ${secs}s.`,
      );
    }
  }

  /** Record a wrong-password attempt and arm the backoff if over threshold. */
  recordFailure(vaultId: string): void {
    const state = this.states.get(vaultId) ?? { failures: 0, lockedUntil: 0 };
    const failures = state.failures + 1;
    let lockedUntil = 0;
    if (failures >= this.maxAttempts) {
      const overBy = failures - this.maxAttempts; // 0 on the first lockout
      const delay = Math.min(
        this.baseDelayMs * 2 ** overBy,
        this.maxDelayMs,
      );
      lockedUntil = this.now() + delay;
    }
    this.states.set(vaultId, { failures, lockedUntil });
  }

  /** Reset the counter — call after a correct password. */
  recordSuccess(vaultId: string): void {
    this.states.delete(vaultId);
  }
}
