import { type CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import { PasteButton } from "@/components/clipboard/PasteButton";
import { Section } from "@/components/ui/Section";
import type { SignatureRow } from "./PayPanel";

export function SignaturePanel({
  cfg,
  sigs,
  setSigs,
  onBroadcast,
  busy,
}: {
  cfg: CkbMultisigConfig;
  sigs: SignatureRow[];
  setSigs: (s: SignatureRow[]) => void;
  onBroadcast: () => void;
  busy: boolean;
}) {
  return (
    <Section title={`6. Collect signatures (${cfg.m} of ${cfg.n} needed)`}>
      <div className="space-y-3">
        {sigs.map((row, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="flex flex-1 items-center gap-2 text-xs text-fg-muted">
                <span>Signature {i + 1} — from co-signer</span>
                <select
                  value={row.slotIndex}
                  onChange={(e) =>
                    setSigs(
                      sigs.map((r, idx) =>
                        idx === i ? { ...r, slotIndex: Number(e.target.value) } : r,
                      ),
                    )
                  }
                  className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs"
                >
                  {cfg.pubkeyHashes.map((h, idx) => (
                    <option key={idx} value={idx}>
                      {idx + 1}: {h.slice(0, 12)}…{h.slice(-6)}
                    </option>
                  ))}
                </select>
              </label>
              <PasteButton
                title={`Paste signature ${i + 1}`}
                onValue={(v) =>
                  setSigs(
                    sigs.map((r, idx) => (idx === i ? { ...r, signature: v.trim() } : r)),
                  )
                }
              />
            </div>
            <textarea
              value={row.signature}
              onChange={(e) =>
                setSigs(sigs.map((r, idx) => (idx === i ? { ...r, signature: e.target.value } : r)))
              }
              placeholder="0x… (130 hex chars)"
              rows={2}
              spellCheck={false}
              className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onBroadcast}
          disabled={busy || sigs.some((s) => !s.signature.trim())}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "broadcasting…" : "Merge & broadcast"}
        </button>
      </div>
    </Section>
  );
}
