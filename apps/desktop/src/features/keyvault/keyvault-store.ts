import { create } from "zustand";

/**
 * Narrow bridge surface that the store's actions call through.
 * Production: `window.chainpay.keyvault.*`.
 * Tests: stub `(globalThis as unknown as { window: ... }).window.chainpay.keyvault`.
 */
interface KeyvaultBridge {
  status: () => Promise<{ exists: boolean }>;
  create: (password: string) => Promise<{ id: string; lockArgs: string; mnemonic: string }>;
  import: (mnemonic: string, password: string) => Promise<{ id: string; lockArgs: string }>;
  delete: (keyvaultId: string) => Promise<{ ok: boolean }>;
}

/** Returns the live bridge — reads window.chainpay.keyvault each call so tests can swap it. */
function getBridge(): KeyvaultBridge {
  return window.chainpay.keyvault;
}

interface KeyvaultState {
  /** True when an encrypted keyvault blob exists on disk. */
  exists: boolean;
  /**
   * 0x-prefixed 20-byte blake160 lock-args of the derived key.
   * Null until the vault is created or refreshed.
   */
  lockArgs: string | null;
  /**
   * Bech32m CKB address for the derived key.
   * Null until secp256k1 address encoding is wired (Task D3).
   */
  address: string | null;
}

interface KeyvaultStore extends KeyvaultState {
  /**
   * Poll the main process for vault existence and update the store.
   * Call on mount to get the authoritative state.
   */
  refreshStatus: () => Promise<void>;
  /**
   * Generate a new BIP39 mnemonic, encrypt it, and persist it.
   * Returns the mnemonic phrase ONCE for the caller to display.
   * The mnemonic is NOT stored in this store — the caller MUST
   * clear it from React state on confirmation and unmount.
   */
  createNew: (password: string) => Promise<{ mnemonic: string }>;
  /**
   * Import an existing BIP39 mnemonic phrase into the vault.
   * Sets `exists=true` and `lockArgs` on success.
   */
  importMnemonic: (mnemonic: string, password: string) => Promise<void>;
  /**
   * Permanently delete the keyvault blob from disk.
   * Clears `exists`, `lockArgs`, and `address` in the store.
   */
  deleteVault: () => Promise<void>;
}

const VAULT_ID = "main";

export const useKeyvaultStore = create<KeyvaultStore>()((set) => ({
  exists: false,
  lockArgs: null,
  address: null,

  refreshStatus: async () => {
    const { exists } = await getBridge().status();
    set(exists ? { exists } : { exists, lockArgs: null, address: null });
  },

  createNew: async (password) => {
    const result = await getBridge().create(password);
    set({ exists: true, lockArgs: result.lockArgs });
    // Return mnemonic to caller — it MUST NOT be stored in this store.
    return { mnemonic: result.mnemonic };
  },

  importMnemonic: async (mnemonic, password) => {
    const result = await getBridge().import(mnemonic, password);
    set({ exists: true, lockArgs: result.lockArgs });
  },

  deleteVault: async () => {
    await getBridge().delete(VAULT_ID);
    set({ exists: false, lockArgs: null, address: null });
  },
}));
