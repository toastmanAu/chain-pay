import type { SolanaWatchTreasury } from "@chain-pay/shared";
import { useSolanaWatchStore } from "@/stores/solana-watch";
import { solanaBridge, type SolanaBridge } from "./ipc";

export async function syncSolanaWatch(
  treasury: SolanaWatchTreasury,
  bridge: SolanaBridge = solanaBridge(),
): Promise<void> {
  const store = useSolanaWatchStore.getState();
  store.beginSync(treasury.id, treasury.watch);
  try {
    const response = await bridge.scan(treasury.watch);
    useSolanaWatchStore.getState().commitSync(treasury.id, response.snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Solana provider is unavailable";
    useSolanaWatchStore.getState().failSync(treasury.id, message);
    throw error;
  }
}
