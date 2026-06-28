import { Transaction, stringify } from "@ckb-ccc/core";
import type { CkbTxSigner } from "./ckb-tx-signer";
import type { SignPreview } from "./joyid-relay/types";
import type { Hex20 } from "@shared/types";

/** Narrow bridge surface injected for testability (production: `window.chainpay.keyvault`). */
interface KeyvaultBridge {
  signTx(req: unknown): Promise<{ signedTx: string }>;
}

interface LocalSignerOpts {
  /** ID of the keyvault blob file (e.g. "main"). */
  keyvaultId: string;
  /** BIP32 child index: m/44'/309'/0'/0/<derivationIndex>. */
  derivationIndex: number;
  /** 0x-prefixed 20-byte blake160 lock-args of the source cell. */
  sourceLockArgs: Hex20;
  /**
   * User password. Held only for the lifetime of this signer instance and
   * sent once to main via the IPC bridge. Never logged or persisted in the
   * renderer beyond the signer's lifecycle.
   */
  password: string;
  /** IPC bridge to the main-process keyvault host. */
  bridge: KeyvaultBridge;
}

/**
 * `CkbTxSigner` that delegates signing to the Electron main process via the
 * keyvault IPC bridge. Main re-verifies lock-args ownership, recomputes the
 * sighash-all digest, and signs inside the WASM vault — the renderer never
 * touches key material.
 *
 * The optional `preview` param (required by the `CkbTxSigner` interface for
 * the JoyID phone-display flow) is accepted but silently ignored — there is
 * no remote device to show a preview on with a local keystore signer.
 */
export class LocalKeystoreCkbTxSigner implements CkbTxSigner {
  readonly kind = "local-keystore" as const;

  constructor(private readonly opts: LocalSignerOpts) {}

  /**
   * No interactive connect step — the keystore is already accessible via
   * password. Returns the pre-known lock-args so callers can treat all signer
   * kinds uniformly.
   */
  async connect(): Promise<{ address: string; lockArgs: string }> {
    return { address: "", lockArgs: this.opts.sourceLockArgs };
  }

  /**
   * Serializes `unsigned`, forwards it to the main-process vault via the IPC
   * bridge, and returns the signed `Transaction`. The `_preview` parameter is
   * part of the `CkbTxSigner` contract but unused here.
   */
  async signTransaction(
    unsigned: Transaction,
    _preview?: SignPreview,
  ): Promise<Transaction> {
    // Single-source single-sig: every input belongs to the source lock.
    // Computed here from the built tx so the caller doesn't need to know
    // the indices at signer-construction time (mirrors JoyID signer behaviour).
    const groupInputIndices = unsigned.inputs.map((_, i) => i);
    const res = await this.opts.bridge.signTx({
      keyvaultId: this.opts.keyvaultId,
      password: this.opts.password,
      derivationIndex: this.opts.derivationIndex,
      unsignedTx: stringify(unsigned),
      sourceLockArgs: this.opts.sourceLockArgs,
      groupInputIndices,
    });
    return Transaction.from(JSON.parse(res.signedTx) as Parameters<typeof Transaction.from>[0]);
  }
}
