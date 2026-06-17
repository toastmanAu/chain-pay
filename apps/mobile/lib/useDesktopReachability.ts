import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { checkReachability } from "@/lib/desktop-reachability";
import type { PairingPayload } from "@/stores/pairing";

export const REACHABILITY_POLL_MS = 10_000;

/**
 * While the screen is focused and paired, polls the desktop health endpoint
 * (immediately, then every REACHABILITY_POLL_MS). Returns:
 *   null  → unpaired / first probe not yet resolved
 *   true  → reachable, false → unreachable
 */
export function useDesktopReachability(pairing: PairingPayload | null): boolean | null {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;

  useFocusEffect(
    useCallback(() => {
      if (!pairing) {
        setReachable(null);
        return;
      }
      let cancelled = false;
      const probe = async (): Promise<void> => {
        const r = await checkReachability(pairingRef.current);
        if (!cancelled) setReachable(r);
      };
      void probe();
      const id = setInterval(() => void probe(), REACHABILITY_POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }, [pairing]),
  );

  return reachable;
}
