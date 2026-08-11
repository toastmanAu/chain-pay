export function chainBadge(chain: string): string {
  if (chain === "ckb:mainnet") return "CKB mainnet";
  if (chain === "ckb:testnet") return "CKB testnet";
  if (chain.startsWith("evm:")) return `EVM ${chain.slice(4)}`;
  if (chain === "btc:mainnet") return "Bitcoin mainnet";
  if (chain === "btc:testnet") return "Bitcoin testnet";
  if (chain === "sol:mainnet") return "Solana mainnet";
  if (chain === "sol:devnet") return "Solana devnet";
  return chain;
}
