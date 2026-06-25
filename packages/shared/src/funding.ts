import type { Identified, Timestamped, Hex20 } from "./types";
import type { ChainId } from "./chainIds";
import type { Treasury } from "./treasury";

export interface FundableAccount {
  id: string;
  label: string;
  chain: ChainId;
  address: string;
  lockKind: "ckb-multisig" | "ckb-joyid-single";
  capabilities: { coSign: boolean };
}

/** A single-sig JoyID-controlled wallet — the non-treasury funding source. */
export interface Source extends Identified, Timestamped {
  label: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  /** JoyID CKB address (ckb1.../ckt1...). */
  address: string;
  /** JoyID lock args, for watchLockScript + change outputs. */
  joyidLockArgs: Hex20;
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
    lockKind: "ckb-joyid-single",
    capabilities: { coSign: false },
  };
}
