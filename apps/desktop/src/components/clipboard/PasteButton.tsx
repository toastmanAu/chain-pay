import { useEffect, useRef, useState } from "react";
import { useClipboardStore } from "@/stores/clipboard";
import { truncate } from "./labelFor";

interface PasteButtonProps {
  /** Fires with the resolved string when the user picks a source. */
  onValue: (value: string) => void;
  /** Tooltip / aria-label override. */
  title?: string;
  className?: string;
}

/**
 * Inline paste affordance. Opens a popover listing the four bins plus a
 * "from system clipboard" option. Filling a field from any bin is two clicks;
 * filling from the OS clipboard reads `navigator.clipboard.readText()` once.
 */
export function PasteButton({ onValue, title, className }: PasteButtonProps) {
  const [open, setOpen] = useState(false);
  const bins = useClipboardStore((s) => s.bins);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pasteFromSystem() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onValue(text);
    } catch {
      // readText can throw if the doc is unfocused or perms missing —
      // surface a hint via the bin contents instead of a console error.
    }
    setOpen(false);
  }

  function pasteBin(value: string) {
    if (value) onValue(value);
    setOpen(false);
  }

  return (
    <div ref={ref} className={"relative inline-block " + (className ?? "")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title ?? "Paste from bin or system clipboard"}
        aria-label={title ?? "Paste"}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-surface-hi bg-surface px-2 py-1 text-xs text-fg-muted transition hover:text-fg"
      >
        <span aria-hidden>⇣</span>
        <span>paste</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-surface-hi bg-surface shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void pasteFromSystem()}
            className="block w-full px-3 py-2 text-left text-xs text-fg hover:bg-surface-hi"
          >
            <div className="font-medium">From system clipboard</div>
            <div className="text-fg-muted">reads navigator.clipboard</div>
          </button>
          <div className="border-t border-surface-hi" />
          {bins.map((bin) => {
            const empty = !bin.value;
            return (
              <button
                key={bin.id}
                type="button"
                role="menuitem"
                disabled={empty}
                onClick={() => pasteBin(bin.value)}
                title={empty ? "" : bin.value}
                className="block w-full px-3 py-2 text-left text-xs hover:bg-surface-hi disabled:cursor-not-allowed disabled:opacity-40"
              >
                <div className="flex items-center justify-between gap-2 font-medium text-fg">
                  <span>
                    {bin.id + 1}. {bin.label}
                  </span>
                  {empty ? <span className="text-fg-muted">empty</span> : null}
                </div>
                {empty ? null : (
                  <div className="break-all font-mono text-[10px] text-fg-muted">
                    {truncate(bin.value, 56)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
