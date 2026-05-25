import { useState } from "react";
import { useClipboardStore, type ClipboardBin } from "@/stores/clipboard";
import { useCommIdentityStore } from "@/stores/comm-identity";
import { useDebugSettingsStore } from "@/stores/debug-settings";
import { useNetworkConfigStore } from "@/stores/network-config";
import { labelFor, truncate } from "./labelFor";

/**
 * Fixed bottom-edge clipboard bar — full width, slim. Each of the four bins
 * is a tier; tiers default to a single-line collapsed view and can expand
 * individually to reveal the full value with monospace wrap. The bar is laid
 * out as a sibling of the main content in AppShell, so its height is always
 * reserved — routes never paint inside it.
 */
export function ClipboardBar() {
  const bins = useClipboardStore((s) => s.bins);
  const identity = useCommIdentityStore((s) => s.identity);
  const showClipboard = useDebugSettingsStore((s) => s.showClipboard);
  const network = useNetworkConfigStore((s) => s.network);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const commActive = identity?.profileTxHash != null;
  // comm is unavailable on mainnet, so the bar is always shown
  // on mainnet. on testnet, hide when comm is active unless debug override.
  const commAvailable = network === "testnet" && commActive;
  const shouldHide = commAvailable && !showClipboard;
  if (shouldHide) return null;

  const allExpanded = expanded.size === bins.length;
  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(bins.map((b) => b.id)));
  const toggleOne = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filledCount = bins.filter((b) => b.value).length;

  return (
    <aside
      aria-label="clipboard"
      className="shrink-0 border-t border-surface-hi bg-surface text-xs"
    >
      <div className="flex items-center justify-between px-4 py-1 text-fg-muted">
        <span>
          Clipboard <span className="tabular-nums text-fg">{filledCount}/{bins.length}</span>
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className="rounded px-2 py-0.5 text-fg-muted hover:bg-surface-hi hover:text-fg"
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <ul>
        {bins.map((bin) => (
          <BinTier
            key={bin.id}
            bin={bin}
            expanded={expanded.has(bin.id)}
            onToggle={() => toggleOne(bin.id)}
          />
        ))}
      </ul>
    </aside>
  );
}

function BinTier({
  bin,
  expanded,
  onToggle,
}: {
  bin: ClipboardBin;
  expanded: boolean;
  onToggle: () => void;
}) {
  const empty = !bin.value;
  const setBin = useClipboardStore((s) => s.setBin);
  const clearBin = useClipboardStore((s) => s.clearBin);

  async function copyOut() {
    if (empty) return;
    try {
      await navigator.clipboard.writeText(bin.value);
    } catch {
      // OS clipboard rejected — bin contents are still intact for retry
    }
  }

  async function saveFromSystem() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setBin(bin.id, text, labelFor(text));
    } catch {
      // permission denied or doc unfocused — leave bin unchanged
    }
  }

  return (
    <li className="border-t border-surface-hi/60 first:border-t-0">
      <div className="flex items-center gap-3 px-4 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `collapse bin ${bin.id + 1}` : `expand bin ${bin.id + 1}`}
          className="w-4 shrink-0 text-fg-muted hover:text-fg"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span
          className={
            "w-28 shrink-0 truncate " +
            (empty ? "text-fg-muted/60" : "font-medium text-fg")
          }
        >
          {bin.id + 1}. {bin.label}
        </span>
        <span
          title={empty ? "" : bin.value}
          className={
            "flex-1 truncate font-mono text-[11px] " +
            (empty ? "italic text-fg-muted/40" : "text-fg-muted")
          }
        >
          {empty ? "— empty —" : truncate(bin.value, 200)}
        </span>
        <div className="flex shrink-0 items-center gap-1 text-fg-muted">
          <BinAction
            onClick={() => void saveFromSystem()}
            title="Save OS clipboard into this bin"
            label={`save into bin ${bin.id + 1}`}
          >
            ⇣
          </BinAction>
          <BinAction
            onClick={() => void copyOut()}
            disabled={empty}
            title="Copy bin to OS clipboard"
            label={`copy out of bin ${bin.id + 1}`}
          >
            ⧉
          </BinAction>
          <BinAction
            onClick={() => clearBin(bin.id)}
            disabled={empty}
            title="Clear bin"
            label={`clear bin ${bin.id + 1}`}
            danger
          >
            ✕
          </BinAction>
        </div>
      </div>
      {expanded && !empty ? (
        <div className="border-t border-surface-hi/60 bg-bg/40 px-4 py-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-fg">
            {bin.value}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

function BinAction({
  children,
  onClick,
  disabled,
  title,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className={
        "rounded px-1.5 py-0.5 transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-30 " +
        (danger ? "hover:bg-danger/30" : "hover:bg-surface-hi")
      }
    >
      {children}
    </button>
  );
}
