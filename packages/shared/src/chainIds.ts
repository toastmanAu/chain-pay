export type CkbChainId = `ckb:mainnet` | `ckb:testnet`;
export type EvmChainId = `evm:${number}`;
export type BtcChainId = `btc:mainnet` | `btc:testnet`;
export type SolChainId = `sol:mainnet` | `sol:devnet`;

export type ChainId = CkbChainId | EvmChainId | BtcChainId | SolChainId;

export type ChainFamily = "ckb" | "evm" | "btc" | "sol";

export function chainFamily(id: ChainId): ChainFamily {
  return id.split(":")[0] as ChainFamily;
}

export const KNOWN_EVM_CHAINS = {
  1: { name: "Ethereum", nativeAsset: "ETH" },
  10: { name: "Optimism", nativeAsset: "ETH" },
  137: { name: "Polygon", nativeAsset: "MATIC" },
  8453: { name: "Base", nativeAsset: "ETH" },
  42161: { name: "Arbitrum One", nativeAsset: "ETH" },
} as const satisfies Record<number, { name: string; nativeAsset: string }>;
