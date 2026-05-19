import type { EvmAddress } from "@chain-pay/shared";

/**
 * Safe multisig configuration. Phase 3 wires this against `@safe-global/protocol-kit`.
 */
export interface SafeConfig {
  /** Chain id (1 for Ethereum mainnet, 42161 for Arbitrum, etc.). */
  chainId: number;
  /** Safe contract address. */
  address: EvmAddress;
  /** Safe owner addresses (EOAs, hardware wallets, or other contracts). */
  owners: EvmAddress[];
  /** Threshold M-of-N. */
  threshold: number;
  /** Safe contract version (defaults to "1.4.1" — current at scaffold time). */
  version?: string;
}

export interface SafeTx {
  to: EvmAddress;
  value: bigint;
  data: `0x${string}`;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: EvmAddress;
  refundReceiver: EvmAddress;
  nonce: bigint;
}

export async function buildSafeTx(_cfg: SafeConfig, _tx: Omit<SafeTx, "nonce">): Promise<SafeTx> {
  throw new Error("buildSafeTx — Phase 3");
}

export async function safeTxHash(_cfg: SafeConfig, _tx: SafeTx): Promise<`0x${string}`> {
  throw new Error("safeTxHash — Phase 3 (EIP-712 hashTypedData)");
}
