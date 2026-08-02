import type { ChainId } from "@chain-pay/shared";
import type { ChainAdapter } from "./types";
import { ckbAdapter } from "./ckb/adapter";
import { evmAdapter } from "./evm/adapter";
import { bitcoinAdapter } from "./btc/adapter";
import { solAdapterStub } from "./sol/_stub";

const adapters = new Map<ChainId, ChainAdapter>([
  ["ckb:mainnet", ckbAdapter("mainnet")],
  ["ckb:testnet", ckbAdapter("testnet")],
  ["evm:1", evmAdapter(1)],
  ["evm:11155111", evmAdapter(11155111)],
  ["evm:42161", evmAdapter(42161)],
  ["evm:10", evmAdapter(10)],
  ["evm:8453", evmAdapter(8453)],
  ["evm:137", evmAdapter(137)],
  ["btc:mainnet", bitcoinAdapter("btc:mainnet")],
  ["btc:testnet", bitcoinAdapter("btc:testnet")],
  ["sol:mainnet", solAdapterStub],
]);

export function getAdapter(chain: ChainId): ChainAdapter {
  const a = adapters.get(chain);
  if (!a) throw new Error(`no adapter registered for chain ${chain}`);
  return a;
}

export function listEnabledAdapters(): ChainAdapter[] {
  return [...adapters.values()].filter((a) => a.status !== "unavailable");
}

export function registerAdapter(chain: ChainId, adapter: ChainAdapter): void {
  adapters.set(chain, adapter);
}
