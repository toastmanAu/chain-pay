import { useState, useEffect, useCallback, useRef } from "react";
import type { Script } from "@ckb-ccc/core";
import { lightClient } from "@/lib/light-client/client";

export interface LightClientDeps {
  watchLockScript: (script: Script) => Promise<void>;
  getLockBalance: (script: Script) => Promise<bigint>;
}

export interface KeystoreBalanceResult {
  balance: bigint | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Subscribes the embedded light client to a lock script and fetches its live
 * CKB balance (in shannons).
 *
 * Lifecycle:
 *  - On mount (or when `lock` changes to a new reference), calls
 *    `watchLockScript(lock)` exactly once so the WASM light client begins
 *    syncing blocks touching that lock. Without this, `getLockBalance` returns
 *    0 for addresses the client has never watched.
 *  - Immediately after watching, calls `getLockBalance(lock)` and stores the
 *    result as `balance`.
 *  - `refresh()` triggers a re-fetch of the balance WITHOUT re-watching.
 *  - A failing `getLockBalance` sets `error` and leaves `balance` as the last
 *    known value (null on first failure). It never throws to the caller —
 *    balance-fetch failure is a warning, not a hard block.
 *  - A null `lock` produces no network calls.
 *
 * Inject `deps` in tests to avoid real IPC.
 */
export function useKeystoreBalance(
  lock: Script | null,
  deps?: LightClientDeps,
): KeystoreBalanceResult {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Track which Script reference we have already watched so refresh() does
  // not trigger redundant watchLockScript calls.
  const watchedRef = useRef<Script | null>(null);

  useEffect(() => {
    if (!lock) return;

    let cancelled = false;

    const lc: LightClientDeps = deps ?? {
      watchLockScript: (s) => lightClient().watchLockScript(s),
      getLockBalance: (s) => lightClient().getLockBalance(s),
    };

    void (async () => {
      // Watch exactly once per distinct lock reference. A new Script object
      // with the same args causes a re-watch — callers should stabilise the
      // reference with useMemo when the lock doesn't logically change.
      if (watchedRef.current !== lock) {
        watchedRef.current = lock;
        await lc.watchLockScript(lock);
      }
      if (cancelled) return;

      setLoading(true);
      try {
        const bal = await lc.getLockBalance(lock);
        if (cancelled) return;
        setBalance(bal);
        setError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        // Surface as a warning — do NOT rethrow to the caller.
        setError(err instanceof Error ? err.message : "balance fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lock, refreshTick, deps]);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  return { balance, loading, error, refresh };
}
