/**
 * How far back from the chain tip to start syncing a *freshly created* wallet's
 * lock script. A brand-new keystore can have no funding older than the moment
 * it was created, so there's no reason to filter-sync from genesis (millions of
 * testnet blocks) — that's why a newly funded balance appears to "never update".
 *
 * The margin only needs to cover the gap between creating the wallet and funding
 * it (plus reorg/clock slack). ~10k blocks is roughly a day on CKB and still
 * filter-syncs in seconds versus the full chain.
 *
 * NOTE: this is for NEW wallets only. A *connected* wallet (e.g. JoyID) may hold
 * coins from before this margin, so it must still watch from genesis.
 */
export const FRESH_WALLET_WATCH_MARGIN_BLOCKS = 10_000n;

/**
 * Block number a fresh wallet should start watching from: `tip - margin`,
 * clamped at 0 so a low tip never underflows below genesis.
 */
export function recentWatchBlock(
  tipNumber: bigint,
  marginBlocks: bigint = FRESH_WALLET_WATCH_MARGIN_BLOCKS,
): bigint {
  return tipNumber > marginBlocks ? tipNumber - marginBlocks : 0n;
}
