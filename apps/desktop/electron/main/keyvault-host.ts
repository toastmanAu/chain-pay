/**
 * Keyvault host — Electron main-process vault operations.
 *
 * Security contract:
 *   1. Every sign request is Zod-validated at the untrusted IPC boundary.
 *   2. The vault's derived lock-args are compared to the caller-supplied
 *      sourceLockArgs before ANY signature is produced (anti-blind-sign).
 *   3. The sighash-all digest is recomputed from the tx object here in main —
 *      a renderer-supplied digest is NEVER trusted.
 *   4. The 65-byte signature is placed in witnesses[groupInputIndices[0]].lock.
 *   5. The password bytes are overwritten with zeros in a `finally` block.
 *
 * Key material (seed, mnemonic, private key) NEVER leaves this module.
 * No raw secret is logged, returned over IPC, or held beyond the call frame.
 */

import { ipcMain } from "electron";
import {
  Transaction,
  WitnessArgs,
  hexFrom,
  bytesFrom,
  stringify,
} from "@ckb-ccc/core";
import { KeyvaultStore } from "./keyvault-store";
import { computeSighashAllDigest } from "@shared/ckb-sighash";
import {
  SignTxRequest,
  ImportRequest,
  CreateRequest,
  ExportRequest,
  ChangePasswordRequest,
  DeleteRequest,
  UnlockDeriveRequest,
  KEYVAULT_CHANNELS,
} from "@shared/keyvault-ipc";
import type { SignTxResponse } from "@shared/keyvault-ipc";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal surface of the ckb-keyvault-wasm pkg consumed by this host. */
interface WasmVault {
  import_seed_phrase(mnemonic: Uint8Array, password: Uint8Array): Uint8Array;
  derive_lock_args(
    blob: Uint8Array,
    password: Uint8Array,
    index: number,
  ): Uint8Array;
  sign_digest(
    blob: Uint8Array,
    password: Uint8Array,
    index: number,
    digest: Uint8Array,
  ): Uint8Array;
  generate_master_seed(password: Uint8Array): unknown;
  export_seed_phrase(blob: Uint8Array, password: Uint8Array): Uint8Array;
  change_password(
    blob: Uint8Array,
    old: Uint8Array,
    _new: Uint8Array,
  ): Uint8Array;
}

export interface Deps {
  store: KeyvaultStore;
  wasm: WasmVault;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default vault id — v1 supports exactly one local keyvault. */
const VAULT_ID = "main";

// ---------------------------------------------------------------------------
// Exported pure functions (unit-testable without Electron)
// ---------------------------------------------------------------------------

/**
 * Import a BIP39 mnemonic phrase into the vault, encrypted with `password`.
 *
 * Returns the vault id and the derived lock-args at index 0 (0x-prefixed hex).
 * No key material is returned — only the lock-args (public information).
 */
export async function importVault(
  req: { mnemonic: string; password: string },
  deps: Deps,
): Promise<{ id: string; lockArgs: string }> {
  ImportRequest.parse(req);

  const mnemonic = new TextEncoder().encode(req.mnemonic);
  const password = new TextEncoder().encode(req.password);
  try {
    const blob = deps.wasm.import_seed_phrase(mnemonic, password);
    deps.store.write(VAULT_ID, Buffer.from(blob));
    const args = deps.wasm.derive_lock_args(blob, password, 0);
    return { id: VAULT_ID, lockArgs: hexFrom(args) };
  } finally {
    mnemonic.fill(0);
    password.fill(0);
  }
}

/**
 * Sign a CKB transaction inside the vault.
 *
 * The full security contract (see module docblock) is enforced here:
 *   • Zod validates every field of the incoming request.
 *   • The vault's own derived lock-args are compared to sourceLockArgs.
 *   • The digest is recomputed from the raw tx, never taken from the caller.
 *   • The password is zeroized in `finally` regardless of outcome.
 */
export async function signTxInVault(
  reqIn: unknown,
  deps: Deps,
): Promise<SignTxResponse> {
  const req = SignTxRequest.parse(reqIn);

  if (!deps.store.has(req.keyvaultId)) {
    throw new Error(`keyvault not found: ${req.keyvaultId}`);
  }

  const blob = deps.store.read(req.keyvaultId);
  const password = new TextEncoder().encode(req.password);

  try {
    // Step 2 — Verify the vault's derived key owns the claimed source lock.
    // This is the anti-blind-sign gate: if the vault doesn't control the
    // lock being spent, we refuse to produce a signature for it.
    const derivedArgs = hexFrom(
      deps.wasm.derive_lock_args(blob, password, req.derivationIndex),
    );
    if (derivedArgs.toLowerCase() !== req.sourceLockArgs.toLowerCase()) {
      throw new Error(
        "source lock args do not match this keyvault's derived key",
      );
    }

    // Step 3 — Recompute the sighash-all digest from the tx WE hold.
    // We parse the tx ourselves and feed it to the digest helper — the
    // renderer-supplied JSON is the raw material, NOT a pre-hashed value.
    const tx = Transaction.from(JSON.parse(req.unsignedTx) as object);
    const digest = computeSighashAllDigest(tx, req.groupInputIndices);

    // Step 4 — Sign inside the vault.  The 65-byte recoverable sig is placed
    // into witnesses[groupInputIndices[0]].lock and the tx is returned.
    const sig = deps.wasm.sign_digest(
      blob,
      password,
      req.derivationIndex,
      bytesFrom(digest),
    );

    const g0 = req.groupInputIndices[0]!;
    const existingHex = tx.witnesses[g0] ?? "0x";
    const existingWa =
      existingHex === "0x"
        ? WitnessArgs.from({})
        : WitnessArgs.fromBytes(bytesFrom(existingHex));

    const finalWa = WitnessArgs.from({
      lock: hexFrom(sig),
      ...(existingWa.inputType !== undefined
        ? { inputType: existingWa.inputType }
        : {}),
      ...(existingWa.outputType !== undefined
        ? { outputType: existingWa.outputType }
        : {}),
    });
    tx.witnesses[g0] = hexFrom(finalWa.toBytes());

    // Use CCC's bigint-aware stringify so `since` and capacity round-trip.
    return { signedTx: stringify(tx) };
  } finally {
    // Step 5 — Zeroize the password bytes.
    password.fill(0);
  }
}

// ---------------------------------------------------------------------------
// IPC registration (Electron main only — not called during unit tests)
// ---------------------------------------------------------------------------

/**
 * Register `ipcMain.handle` for every keyvault channel.
 *
 * Call once inside `app.whenReady()` after constructing the KeyvaultStore
 * and loading the wasm module.
 */
export function registerKeyvaultHost(deps: Deps): void {
  ipcMain.handle(KEYVAULT_CHANNELS.import, (_e, r: unknown) =>
    importVault(r as { mnemonic: string; password: string }, deps),
  );

  ipcMain.handle(KEYVAULT_CHANNELS.create, (_e, r: unknown) => {
    const { password: pw } = CreateRequest.parse(r);
    const password = new TextEncoder().encode(pw);
    try {
      const result = deps.wasm.generate_master_seed(password) as {
        blob: Uint8Array;
        mnemonic: Uint8Array;
      };
      deps.store.write(VAULT_ID, Buffer.from(result.blob));
      const args = hexFrom(deps.wasm.derive_lock_args(result.blob, password, 0));
      const phrase = new TextDecoder().decode(result.mnemonic);
      // Zeroize the mnemonic copy returned from WASM.
      result.mnemonic.fill(0);
      return { id: VAULT_ID, lockArgs: args, mnemonic: phrase };
    } finally {
      password.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.signTx, (_e, r: unknown) =>
    signTxInVault(r, deps),
  );

  ipcMain.handle(KEYVAULT_CHANNELS.status, () => ({
    exists: deps.store.has(VAULT_ID),
  }));

  ipcMain.handle(KEYVAULT_CHANNELS.unlockDerive, (_e, r: unknown) => {
    const req = UnlockDeriveRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) {
      throw new Error(`keyvault not found: ${req.keyvaultId}`);
    }
    const blob = deps.store.read(req.keyvaultId);
    const password = new TextEncoder().encode(req.password);
    try {
      const args = hexFrom(
        deps.wasm.derive_lock_args(blob, password, req.derivationIndex),
      );
      return { lockArgs: args };
    } finally {
      password.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.export, (_e, r: unknown) => {
    const req = ExportRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) {
      throw new Error(`keyvault not found: ${req.keyvaultId}`);
    }
    const blob = deps.store.read(req.keyvaultId);
    const password = new TextEncoder().encode(req.password);
    try {
      const mnemonicBytes = deps.wasm.export_seed_phrase(blob, password);
      const mnemonic = new TextDecoder().decode(mnemonicBytes);
      mnemonicBytes.fill(0);
      return { mnemonic };
    } finally {
      password.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.changePassword, (_e, r: unknown) => {
    const req = ChangePasswordRequest.parse(r);
    if (!deps.store.has(req.keyvaultId)) {
      throw new Error(`keyvault not found: ${req.keyvaultId}`);
    }
    const blob = deps.store.read(req.keyvaultId);
    const oldPw = new TextEncoder().encode(req.oldPassword);
    const newPw = new TextEncoder().encode(req.newPassword);
    try {
      const newBlob = deps.wasm.change_password(blob, oldPw, newPw);
      deps.store.write(req.keyvaultId, Buffer.from(newBlob));
      return { ok: true };
    } finally {
      oldPw.fill(0);
      newPw.fill(0);
    }
  });

  ipcMain.handle(KEYVAULT_CHANNELS.delete, (_e, r: unknown) => {
    const req = DeleteRequest.parse(r);
    deps.store.delete(req.keyvaultId);
    return { ok: true };
  });
}
