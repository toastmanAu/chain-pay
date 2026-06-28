import { useEffect, useRef, useState } from "react";
import { useKeyvaultStore } from "./keyvault-store";
import { ReceivePanel } from "./ReceivePanel";

// ---------------------------------------------------------------------------
// Password entropy meter (client-side heuristic — no IPC)
// ---------------------------------------------------------------------------

function estimateEntropyBits(password: string): number {
  if (password.length === 0) return 0;
  let charset = 0;
  if (/[a-z]/.test(password)) charset += 26;
  if (/[A-Z]/.test(password)) charset += 26;
  if (/[0-9]/.test(password)) charset += 10;
  if (/[^a-zA-Z0-9]/.test(password)) charset += 33;
  return Math.floor(password.length * Math.log2(Math.max(charset, 1)));
}

function entropyLabel(bits: number): { label: string; color: string } {
  if (bits < 40) return { label: "Weak", color: "text-danger" };
  if (bits < 60) return { label: "Moderate", color: "text-warn" };
  return { label: "Strong", color: "text-green-400" };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

function PasswordField({ id, label, value, onChange, autoFocus }: PasswordFieldProps) {
  const bits = estimateEntropyBits(value);
  const { label: strengthLabel, color } = entropyLabel(bits);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
      />
      {value.length > 0 && (
        <p className={`text-xs ${color}`}>
          Strength: {strengthLabel} ({bits} bits)
        </p>
      )}
    </div>
  );
}

interface ErrorBannerProps {
  message: string;
}

function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel modes
// ---------------------------------------------------------------------------

type PanelMode = "idle" | "creating" | "showing-mnemonic" | "importing" | "active";

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

/**
 * Keyvault setup panel: create a new local keystore, import an existing
 * mnemonic, or manage an existing vault.
 *
 * Security invariants:
 * - The mnemonic returned by `createNew` is held ONLY in local React state.
 * - It is cleared immediately when the user confirms ("I've written it down").
 * - A `useEffect` cleanup also clears it on unmount, so no route-change leak.
 * - The mnemonic is NEVER stored in the Zustand store.
 */
export function KeyvaultSetupPanel() {
  const { exists, lockArgs, refreshStatus, createNew, importMnemonic, deleteVault } =
    useKeyvaultStore();

  const [mode, setMode] = useState<PanelMode>(exists ? "active" : "idle");
  const [password, setPassword] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // SECURITY: Mnemonic lives ONLY here — NOT in the store, NOT logged.
  const [mnemonic, setMnemonic] = useState("");

  // SECURITY: Clear mnemonic on unmount (e.g. user navigates away mid-flow).
  const setMnemonicRef = useRef(setMnemonic);
  setMnemonicRef.current = setMnemonic;
  useEffect(() => {
    return () => {
      setMnemonicRef.current("");
    };
  }, []);

  // Sync mode when `exists` changes (e.g. after refreshStatus on mount).
  useEffect(() => {
    if (exists && mode !== "showing-mnemonic") {
      setMode("active");
    }
    if (!exists && mode === "active") {
      setMode("idle");
    }
  }, [exists, mode]);

  // Refresh vault status on mount so the panel reflects disk state.
  useEffect(() => {
    void refreshStatus().catch(() => {
      // Non-fatal: IPC unavailable in test/dev; start state is already `false`.
    });
  }, [refreshStatus]);

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function clearFormState(): void {
    setPassword("");
    setMnemonicInput("");
    setError(null);
    setLoading(false);
  }

  async function handleCreate(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      const result = await createNew(password);
      setPassword("");
      setMnemonic(result.mnemonic); // held in local state only
      setMode("showing-mnemonic");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet creation failed");
    } finally {
      setLoading(false);
    }
  }

  function handleMnemonicConfirmed(): void {
    setMnemonic(""); // SECURITY: clear immediately on user confirmation
    setMode("active");
    setError(null);
  }

  async function handleImport(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await importMnemonic(mnemonicInput, password);
      clearFormState();
      setMode("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mnemonic import failed");
      setLoading(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleteConfirm(false);
    setError(null);
    try {
      await deleteVault();
      setMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const wrapper = (children: React.ReactNode): React.ReactElement => (
    <section className="rounded-lg border border-surface-hi bg-surface p-5">
      <h2 className="mb-4 text-lg font-semibold">Local wallet</h2>
      {children}
    </section>
  );

  // — Idle: no wallet yet —
  if (mode === "idle") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Create a password-protected BIP39 secp256k1 wallet stored on this device. The seed is
          encrypted by the Electron main process — your private key never touches the renderer.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("creating"); }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Create new wallet
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("importing"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Import mnemonic
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Create flow: password entry —
  if (mode === "creating") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Choose a strong password. This encrypts your seed — you will need it every time you
          sign a transaction.
        </p>
        <PasswordField
          id="kv-create-password"
          label="Wallet password"
          value={password}
          onChange={setPassword}
          autoFocus
        />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={loading || password.length < 8}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create wallet"}
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("idle"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Create flow: show mnemonic once —
  if (mode === "showing-mnemonic") {
    const words = mnemonic.trim().split(/\s+/);
    return wrapper(
      <div className="space-y-4">
        <div
          role="alert"
          className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm text-warn"
        >
          <strong>Write these words down.</strong> They are shown exactly once and cannot be
          recovered if lost. Store them securely offline.
        </div>
        <ol
          aria-label="Recovery mnemonic"
          className="grid grid-cols-3 gap-2 rounded-lg border border-surface-hi bg-bg p-4 text-sm font-mono"
        >
          {words.map((word, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs text-fg-muted">{i + 1}.</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={handleMnemonicConfirmed}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          I&apos;ve written it down — continue
        </button>
      </div>,
    );
  }

  // — Import flow —
  if (mode === "importing") {
    return wrapper(
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Paste your 12- or 24-word BIP39 mnemonic phrase, then choose a password to protect it
          on this device.
        </p>
        <div className="space-y-1">
          <label htmlFor="kv-import-mnemonic" className="block text-sm text-fg-muted">
            Mnemonic phrase
          </label>
          <textarea
            id="kv-import-mnemonic"
            rows={3}
            autoFocus
            value={mnemonicInput}
            onChange={(e) => setMnemonicInput(e.target.value)}
            placeholder="abandon abandon abandon …"
            className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
          />
        </div>
        <PasswordField
          id="kv-import-password"
          label="Wallet password"
          value={password}
          onChange={setPassword}
        />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={loading || mnemonicInput.trim().length === 0 || password.length < 8}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Importing…" : "Import wallet"}
          </button>
          <button
            type="button"
            onClick={() => { clearFormState(); setMode("idle"); }}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>,
    );
  }

  // — Active: wallet exists —
  return wrapper(
    <div className="space-y-4">
      {/* Receive / Fund panel: address + QR + live balance */}
      {lockArgs && <ReceivePanel lockArgs={lockArgs} />}

      {/* Lock args (technical detail, below the user-facing panel) */}
      <div className="rounded-lg border border-surface-hi bg-bg p-4 text-sm">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Lock args (blake160)</div>
        <div className="mt-1 break-all font-mono text-xs text-accent">
          {lockArgs ?? "—"}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {!deleteConfirm ? (
        <button
          type="button"
          onClick={() => setDeleteConfirm(true)}
          className="rounded-md border border-danger/40 bg-danger/5 px-3 py-1 text-xs text-danger hover:opacity-90"
        >
          Delete wallet
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <p className="text-danger">
            This permanently deletes the encrypted vault from disk. The seed cannot be recovered
            without your mnemonic backup.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleDelete()}
              className="rounded-md bg-danger px-3 py-1 text-xs font-medium text-white"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirm(false)}
              className="rounded-md border border-surface-hi bg-bg px-3 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>,
  );
}
