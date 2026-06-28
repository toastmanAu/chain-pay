import type { Identified, Timestamped, Hex20 } from "./types";
import type { ChainId } from "./chainIds";
import type { Treasury } from "./treasury";

export interface FundableAccount {
  id: string;
  label: string;
  chain: ChainId;
  address: string;
  lockKind: "ckb-multisig" | "ckb-joyid-single" | "ckb-secp256k1-single";
  capabilities: { coSign: boolean };
}

/**
 * A single-sig non-treasury funding source. Two signer kinds:
 *  - "joyid" (default/absent): JoyID-own-lock, signed via the JoyID relay.
 *  - "secp256k1": a local encrypted BIP39 keystore signing the
 *    `secp256k1_blake160_sighash_all` lock in the Electron main process.
 *    Custody for this kind is permitted ONLY on this non-treasury SMB send
 *    path (treasury stays multisig/external — see CLAUDE.md Hard Rule #1).
 */
export interface Source extends Identified, Timestamped {
  label: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  /** CKB address (ckb1.../ckt1...). */
  address: string;
  /**
   * blake160 lock args, for watchLockScript + change outputs. Field name is
   * historical (introduced for JoyID); for `lockKind: "secp256k1"` it holds the
   * keystore-derived secp256k1 blake160 args — same Hex20 shape.
   */
  joyidLockArgs: Hex20;
  /** Signer/lock kind. Absent ⇒ "joyid" (back-compat with existing sources). */
  lockKind?: "joyid" | "secp256k1";
  /** For lockKind "secp256k1": the keyvault id that owns this lock. */
  keyvaultId?: string;
  /** For lockKind "secp256k1": BIP32 derivation index (default 0). */
  derivationIndex?: number;
  notes?: string;
}

export function treasuryAsFundable(t: Treasury): FundableAccount {
  return {
    id: t.id,
    label: t.label,
    chain: t.multisig.chain,
    address: t.multisig.address,
    lockKind: "ckb-multisig",
    capabilities: { coSign: true },
  };
}

export function sourceAsFundable(s: Source): FundableAccount {
  return {
    id: s.id,
    label: s.label,
    chain: s.chain,
    address: s.address,
    lockKind: s.lockKind === "secp256k1" ? "ckb-secp256k1-single" : "ckb-joyid-single",
    capabilities: { coSign: false },
  };
}
