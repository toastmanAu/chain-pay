import bs58 from "bs58";
import type { PayeeAddress, SolanaChain } from "@chain-pay/shared";

export function parseSolanaAddress(value: string, _chain?: SolanaChain): PayeeAddress {
  const address = value.trim();
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(address);
  } catch {
    throw new Error("Enter a valid base58 Solana public address");
  }
  if (bytes.length !== 32 || bs58.encode(bytes) !== address) {
    throw new Error("A Solana public address must canonically encode exactly 32 bytes");
  }
  return address as PayeeAddress;
}

export function solanaWatchIdentity(chain: SolanaChain, address: string): string {
  return `${chain}:${parseSolanaAddress(address, chain)}`;
}
