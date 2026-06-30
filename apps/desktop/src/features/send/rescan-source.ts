import type { Source } from "@chain-pay/shared";

/**
 * Resolve a source's lock from its stored address (kind-agnostic: the address
 * encodes the full lock script) and re-scan it from `fromBlock`. Mirrors the
 * dynamic-import shape of SourceList.handleConnect so it shares no module-load
 * cost with tests. Injected into RescanControl; the component is tested with a
 * stub instead.
 */
export async function rescanSourceFromBlock(source: Source, fromBlock: bigint): Promise<void> {
  const { Address, ClientPublicMainnet, ClientPublicTestnet } = await import("@ckb-ccc/core");
  const { lightClient } = await import("@/lib/light-client/client");
  const client =
    source.chain === "ckb:mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  const parsed = await Address.fromString(source.address, client);
  await lightClient().rescanLockFromBlock(parsed.script, fromBlock);
}

/** Best-effort current tip for upper-bound validation; null on any failure. */
export async function fetchLcTip(): Promise<bigint | null> {
  try {
    const { lightClient } = await import("@/lib/light-client/client");
    const tip = await lightClient().getTipHeader();
    return BigInt(tip.number ?? 0);
  } catch {
    return null;
  }
}
