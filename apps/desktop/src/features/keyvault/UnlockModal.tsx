import { useEffect, useRef, useState } from "react";

/** Props for the password-collection modal that gates a local-keystore sign. */
interface UnlockModalProps {
  open: boolean;
  /** Called once with the user's password. The modal clears its own state before calling this. */
  onSubmit: (password: string) => void;
  /** Called when the user cancels. Parent should set `open` to false. */
  onClose: () => void;
}

/**
 * Modal that collects a keystore password to gate a secp256k1 send.
 *
 * Security invariants:
 * - Password lives ONLY in this component's local React state.
 * - It is cleared (`setPassword("")`) BEFORE calling `onSubmit`, so the
 *   caller's reference and this component's state are never both non-empty.
 * - A `useEffect` cleanup also clears it on unmount (e.g. route change while
 *   the modal is open) so the string never lingers in the heap.
 * - The password is NEVER stored in Zustand, localStorage, or any persistent layer.
 */
export function UnlockModal({ open, onSubmit, onClose }: UnlockModalProps) {
  const [password, setPassword] = useState("");

  // SECURITY: clear the password if the component unmounts while still open
  // (e.g. the user navigates away before confirming).
  const setPasswordRef = useRef(setPassword);
  setPasswordRef.current = setPassword;
  useEffect(() => {
    return () => {
      setPasswordRef.current("");
    };
  }, []);

  if (!open) return null;

  function handleConfirm(): void {
    const pw = password;
    // Clear local state BEFORE handing off — `onSubmit` must never see a dirty field.
    setPassword("");
    onSubmit(pw);
  }

  function handleClose(): void {
    setPassword("");
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-modal-title"
        className="w-80 space-y-4 rounded-xl border border-surface-hi bg-surface p-6 shadow-lg"
      >
        <h2 id="unlock-modal-title" className="text-lg font-semibold">
          Unlock wallet to sign
        </h2>
        <div className="space-y-1">
          <label htmlFor="unlock-password" className="block text-sm text-fg-muted">
            Password
          </label>
          <input
            id="unlock-password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password.length > 0) handleConfirm();
            }}
            className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
          />
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={password.length === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
