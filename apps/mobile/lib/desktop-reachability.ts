import { healthCheck } from "@/lib/transport/ip-client";
import type { PairingPayload } from "@/stores/pairing";

/**
 * Returns desktop reachability for the Home banner.
 * - null  → not paired (no probe attempted)
 * - true  → desktop answered the pinned health check
 * - false → unreachable (health check failed or threw)
 */
export async function checkReachability(pairing: PairingPayload | null): Promise<boolean | null> {
  if (!pairing) return null;
  try {
    return await healthCheck(pairing);
  } catch {
    return false;
  }
}
