import { useEffect, useMemo, useRef, useState } from "react";
import type { PayeeProfile } from "@chain-pay/shared";
import { usePayeesStore } from "@/stores/payees";

interface PayeePickerProps {
  /** Restrict the list to payees whose `preferredChain` matches. */
  chainFilter: PayeeProfile["preferredChain"];
  /** Fires with the user-selected payees when "Add selected" is clicked. */
  onAdd: (payees: PayeeProfile[]) => void;
}

/**
 * Popover dropdown that lists the user's active payees and lets the operator
 * fan them into the recipient rows of the current payment draft. Reads from
 * the persisted payees store; amounts are not set here — that's the FX step
 * (Phase 2.5 step 4). For now, each picked payee creates a row with the
 * address filled and the amount left empty for manual entry.
 */
export function PayeePicker({ chainFilter, onAdd }: PayeePickerProps) {
  const allPayees = usePayeesStore((s) => s.payees);
  const candidates = useMemo(
    () => allPayees.filter((p) => p.active && p.preferredChain === chainFilter),
    [allPayees, chainFilter],
  );

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
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

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function commit() {
    const selected = candidates.filter((p) => picked.has(p.id));
    if (selected.length > 0) onAdd(selected);
    setPicked(new Set());
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-fg-muted hover:text-fg"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + load from payees
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-lg border border-surface-hi bg-surface shadow-xl"
        >
          <header className="border-b border-surface-hi px-3 py-2 text-xs text-fg-muted">
            Active payees on {chainLabel(chainFilter)}
          </header>
          {candidates.length === 0 ? (
            <p className="px-3 py-3 text-xs text-fg-muted">
              No active payees on this network. Add some on the{" "}
              <span className="text-fg">Employees</span> page first.
            </p>
          ) : (
            <ul className="max-h-64 divide-y divide-surface-hi overflow-y-auto">
              {candidates.map((p) => {
                const isPicked = picked.has(p.id);
                return (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-surface-hi">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => toggle(p.id)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-fg">{p.displayName}</div>
                        <div className="break-all font-mono text-[10px] text-fg-muted">
                          {p.walletAddress}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="flex items-center justify-between border-t border-surface-hi px-3 py-2 text-xs">
            <span className="text-fg-muted">
              {picked.size} selected
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPicked(new Set());
                  setOpen(false);
                }}
                className="rounded px-2 py-1 text-fg-muted hover:text-fg"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={picked.size === 0}
                className="rounded-md bg-accent px-3 py-1 text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add {picked.size > 0 ? `${picked.size} ` : ""}to draft
              </button>
            </div>
          </footer>
        </div>
      ) : null}
    </div>
  );
}

function chainLabel(chain: PayeeProfile["preferredChain"]): string {
  if (chain === "ckb:testnet") return "CKB Testnet";
  if (chain === "ckb:mainnet") return "CKB Mainnet";
  return chain;
}
