import { createPublicClient, http, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

const clients = new Map<number, PublicClient>();

/**
 * EVM RPC is deliberately isolated here so a later settings slice can replace
 * the endpoint without changing treasury or transaction code.
 */
export function getEvmPublicClient(chainId: number): PublicClient {
  if (chainId !== sepolia.id) {
    throw new Error(`EVM chain ${chainId} is not enabled yet`);
  }

  const existing = clients.get(chainId);
  if (existing) return existing;

  const client = createPublicClient({
    chain: sepolia,
    transport: http(getEvmRpcUrl(chainId)),
  });
  clients.set(chainId, client);
  return client;
}

export function getEvmRpcUrl(chainId: number): string {
  if (chainId !== sepolia.id) throw new Error(`EVM chain ${chainId} is not enabled yet`);
  return import.meta.env.VITE_EVM_SEPOLIA_RPC_URL?.trim() || sepolia.rpcUrls.default.http[0];
}
