import type { CkbTxSigner } from "../signers/ckb-tx-signer";

/**
 * Throws if `signer` is a local-keystore signer, preventing it from being
 * used on the treasury or multisig co-signing path.
 *
 * ## Why this guard exists
 *
 * `LocalKeystoreCkbTxSigner` (kind: "local-keystore") is permitted ONLY on the
 * non-treasury single-sig SMB send path (`buildAndSend`). It MUST NOT be used
 * as a treasury signer or a multisig co-signer.
 *
 * ## Is the type system not enough?
 *
 * The treasury path uses `SignerTransport` whose `SignerKind` union does NOT
 * include "local-keystore". TypeScript therefore prevents the cross-assignment
 * at compile time — see the structural invariant test. However:
 *
 * 1. A future developer extending the treasury signing API may add a
 *    `CkbTxSigner` parameter without realising it violates the custody
 *    constraint (e.g. "let's also accept the richer whole-tx signer here").
 * 2. Runtime checks defend against dynamic dispatch patterns that escape the
 *    type checker (deserialized state, `as CkbTxSigner` casts, dynamic `kind`
 *    strings from config or IPC).
 *
 * ## Current call sites
 *
 * Today the treasury path has no `CkbTxSigner` parameter — it uses raw
 * partial-signature merging via `mergeSignatures` and direct ckb-cli key
 * operations in `SignPanel`. This guard is therefore a ready-to-call
 * defense-in-depth checkpoint rather than a live gatekeeper:
 *
 *   - Call it at the entry of any treasury/multisig function that ever gains
 *     a `CkbTxSigner` parameter in the future.
 *   - The co-located test documents the invariant so `tsc --noEmit` will catch
 *     structural violations even when no runtime call is present.
 */
export function assertNotLocalKeystoreSigner(signer: CkbTxSigner): void {
  if (signer.kind === "local-keystore") {
    throw new Error(
      "local keystore signer is not permitted for treasury or multisig signing; " +
        "the local keystore is allowed only on the single-sig SMB send path",
    );
  }
}
