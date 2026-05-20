import { Address, Script } from "@ckb-ccc/core";
import type { CkbMultisigConfig } from "./multisig";
import { lockArgsFromConfig } from "./multisig";
import type { CkbNetwork } from "../../light-client/network-configs";

/**
 * Canonical `secp256k1_blake160_multisig_all` (V1) lock script values.
 *
 * Same code_hash on mainnet and testnet — it's a type-hash, so the cell-dep
 * code can be upgraded without invalidating existing lock args. V2
 * (`Secp256k1MultisigV2`, hash_type `data1`) exists in CCC but isn't
 * universally supported by signer wallets (JoyID, Ledger, ckb-cli) in 2026,
 * so ChainPay uses V1 for treasury v0.1.
 */
export const SECP256K1_MULTISIG_V1_CODE_HASH =
  "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8" as const;

const ADDRESS_PREFIX: Record<CkbNetwork, string> = {
  mainnet: "ckb",
  testnet: "ckt",
};

export interface TreasuryScript {
  codeHash: string;
  hashType: "type";
  args: string;
}

export function treasuryLockScript(cfg: CkbMultisigConfig): TreasuryScript {
  const args = bytesToHex(lockArgsFromConfig(cfg));
  return {
    codeHash: SECP256K1_MULTISIG_V1_CODE_HASH,
    hashType: "type",
    args,
  };
}

export function deriveTreasuryAddress(cfg: CkbMultisigConfig, network: CkbNetwork): string {
  const { codeHash, hashType, args } = treasuryLockScript(cfg);
  const script = Script.from({ codeHash, hashType, args });
  return Address.from({ script, prefix: ADDRESS_PREFIX[network] }).toString();
}

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
