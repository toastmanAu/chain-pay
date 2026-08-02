import type { BitcoinWatchConfig, BitcoinWatchSnapshot } from "@chain-pay/shared";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";
import { bitcoinBridge, type BitcoinBridge } from "./ipc";
import { deriveBitcoinReceiveAddress } from "./watch-source";

const MAX_DERIVED_ADDRESSES = 10_000;

export async function syncBitcoinWatch(args: {
  treasuryId: string;
  config: BitcoinWatchConfig;
  bridge?: BitcoinBridge;
}): Promise<BitcoinWatchSnapshot> {
  const bridge = args.bridge ?? bitcoinBridge();
  const store = useBitcoinWatchStore.getState();
  store.ensure(args.treasuryId, args.config);
  store.beginSync(args.treasuryId, args.config);

  try {
    if (args.config.source.kind === "address") {
      const result = await bridge.scan({
        chain: args.config.chain,
        addresses: [args.config.source.address],
      });
      assertActivityMatches([args.config.source.address], result.activity);
      useBitcoinWatchStore.getState().reconcileDiscovery(args.treasuryId, [result.activity[0]?.used ?? false]);
      useBitcoinWatchStore.getState().commitSync(args.treasuryId, result.snapshot);
      return result.snapshot;
    }

    let state = useBitcoinWatchStore.getState().records[args.treasuryId];
    let upperIndex = Math.max(
      state?.scannedThrough ?? -1,
      (state?.lastUsedIndex ?? -1) + args.config.gapLimit,
      args.config.gapLimit - 1,
    );
    let attempts = 0;
    while (attempts++ < MAX_DERIVED_ADDRESSES) {
      if (upperIndex >= MAX_DERIVED_ADDRESSES) {
        throw new Error(`Bitcoin watch discovery exceeded ${MAX_DERIVED_ADDRESSES} addresses`);
      }
      const addresses = Array.from({ length: upperIndex + 1 }, (_, index) =>
        deriveBitcoinReceiveAddress(args.config, index),
      );
      const result = await bridge.scan({ chain: args.config.chain, addresses });
      assertActivityMatches(addresses, result.activity);
      const usedByIndex = result.activity.map((entry) => entry.used);
      useBitcoinWatchStore.getState().reconcileDiscovery(args.treasuryId, usedByIndex);
      state = useBitcoinWatchStore.getState().records[args.treasuryId];
      const desiredUpper = (state?.lastUsedIndex ?? -1) + args.config.gapLimit;
      if ((state?.consecutiveUnused ?? 0) >= args.config.gapLimit && upperIndex >= desiredUpper) {
        useBitcoinWatchStore.getState().commitSync(args.treasuryId, result.snapshot);
        return result.snapshot;
      }
      upperIndex = Math.max(upperIndex + 1, desiredUpper);
    }
    throw new Error("Bitcoin watch discovery did not converge");
  } catch (caught) {
    const message = safeSyncError(caught);
    useBitcoinWatchStore.getState().failSync(args.treasuryId, message);
    throw new Error(message);
  }
}

function assertActivityMatches(
  addresses: string[],
  activity: { address: string; used: boolean }[],
): void {
  if (
    activity.length !== addresses.length ||
    activity.some((entry, index) => entry.address !== addresses[index])
  ) {
    throw new Error("Bitcoin provider returned mismatched address activity");
  }
}

function safeSyncError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "Bitcoin sync failed";
  // Electron may prefix main-process errors, but the host itself only emits
  // categorized messages. Do not persist anything that resembles a URL or auth token.
  if (/https?:\/\/|bearer|authorization|token/i.test(message)) return "Bitcoin provider sync failed";
  return message.slice(0, 240);
}
