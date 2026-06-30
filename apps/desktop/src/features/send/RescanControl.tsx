import { useEffect, useState } from "react";
import type { Source } from "@chain-pay/shared";
import { parseRescanBlock } from "./parse-rescan-block";
import { rescanSourceFromBlock, fetchLcTip } from "./rescan-source";

interface RescanControlProps {
  source: Source;
  /** Injectable for tests; defaults to the real light-client path. */
  rescan?: (source: Source, fromBlock: bigint) => Promise<void>;
  /** Injectable for tests; best-effort current tip for upper-bound validation. */
  getTip?: () => Promise<bigint | null>;
}

export function RescanControl({
  source,
  rescan = rescanSourceFromBlock,
  getTip = fetchLcTip,
}: RescanControlProps) {
  const [open, setOpen] = useState(false);
  const [blockInput, setBlockInput] = useState("");
  const [tip, setTip] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rescanning, setRescanning] = useState<bigint | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void getTip().then((t) => { if (live) setTip(t); });
    return () => { live = false; };
  }, [open, getTip]);

  async function run(fromBlock: bigint) {
    setBusy(true);
    setError(null);
    try {
      await rescan(source, fromBlock);
      setRescanning(fromBlock);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rescan failed.");
    } finally {
      setBusy(false);
    }
  }

  function onGo() {
    const parsed = parseRescanBlock(blockInput, tip);
    if (!parsed.ok) { setError(parsed.error); return; }
    void run(parsed.block);
  }

  return (
    <div className="ml-3 shrink-0 text-right">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:text-fg"
      >
        Rescan ▾
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded border border-border bg-bg p-2 text-left">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(0n)}
            className="block w-full rounded bg-surface px-2 py-1 text-xs hover:opacity-90 disabled:opacity-50"
          >
            From genesis (complete, slower)
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-fg-muted" htmlFor={`rescan-block-${source.id}`}>
              From block
            </label>
            <input
              id={`rescan-block-${source.id}`}
              inputMode="numeric"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              className="w-28 rounded border border-surface-hi bg-bg px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={busy}
              onClick={onGo}
              className="rounded bg-accent px-2 py-1 text-xs text-accent-fg disabled:opacity-50"
            >
              Go
            </button>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          {rescanning !== null ? (
            <p className="text-xs text-fg-muted">
              Rescanning from block {rescanning.toString()} — balance updates as the light client
              syncs (can take minutes from genesis).
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
