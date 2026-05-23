import { useState } from "react";
import { useClipboardStore } from "@/stores/clipboard";
import { labelFor } from "./labelFor";

interface CopyButtonProps {
  /** The value to copy. Empty string disables the button. */
  value: string;
  /** Optional bin label override; default uses the labelFor heuristic. */
  label?: string;
  /** Tooltip / aria-label override. */
  title?: string;
  className?: string;
}

/**
 * Inline copy affordance. Writes `value` to the OS clipboard and stashes a
 * copy in the next-open bin so it survives across navigation and reloads.
 * Flashes a checkmark for ~1 s to confirm.
 */
export function CopyButton({ value, label, title, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const saveToNextOpen = useClipboardStore((s) => s.saveToNextOpen);
  const disabled = !value;

  async function handleCopy() {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // navigator.clipboard can throw if the renderer lost focus mid-click.
      // We still record into a bin so the user can recover via the dock.
    }
    saveToNextOpen(value, label ?? labelFor(value));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1100);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      title={title ?? (disabled ? "nothing to copy" : "Copy + stash in a bin")}
      aria-label={title ?? "Copy"}
      className={
        "inline-flex items-center gap-1 rounded-md border border-surface-hi bg-surface px-2 py-1 text-xs text-fg-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 " +
        (className ?? "")
      }
    >
      <span aria-hidden>{copied ? "✓" : "⧉"}</span>
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}
