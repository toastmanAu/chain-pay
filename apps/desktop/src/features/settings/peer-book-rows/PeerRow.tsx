import { useMemo, useState } from "react";
import { usePeerBookStore, type Peer } from "@/stores/peer-book";
import { useTreasuryStore } from "@/stores/treasury";

interface PeerRowProps {
  peer: Peer;
}

function shortAddr(addr: string): string {
  if (addr.length < 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

export function PeerRow({ peer }: PeerRowProps) {
  const removePeer = usePeerBookStore((s) => s.removePeer);
  const renamePeer = usePeerBookStore((s) => s.renamePeer);
  const setAssoc = usePeerBookStore((s) => s.setAssociatedSignerHash);
  const treasuries = useTreasuryStore((s) => s.treasuries);

  const [editing, setEditing] = useState(false);
  const [draftNick, setDraftNick] = useState(peer.nickname);
  const [draftHash, setDraftHash] = useState<"" | `0x${string}`>(peer.associatedSignerHash ?? "");
  const [error, setError] = useState<string | null>(null);

  const signerOptions = useMemo(() => {
    const out: { hash: `0x${string}`; label: string }[] = [];
    for (const t of treasuries) {
      if (!("pubkeyHashes" in t.multisig)) continue;
      t.multisig.pubkeyHashes.forEach((hash, i) => {
        out.push({ hash, label: `${t.label} — slot ${i}` });
      });
    }
    return out;
  }, [treasuries]);

  function save(): void {
    setError(null);
    try {
      if (draftNick.trim() !== peer.nickname) {
        renamePeer(peer.address, draftNick.trim());
      }
      if (draftHash !== (peer.associatedSignerHash ?? "")) {
        setAssoc(peer.address, draftHash === "" ? undefined : draftHash);
      }
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (editing) {
    return (
      <div className="space-y-2 rounded border border-surface-hi bg-surface-lo p-3">
        <input
          value={draftNick}
          onChange={(e) => setDraftNick(e.target.value)}
          className="w-full rounded border border-surface-hi bg-surface px-2 py-1 text-sm"
          aria-label="Edit nickname"
        />
        <div className="font-mono text-xs text-fg-muted">{shortAddr(peer.address)}</div>
        <select
          value={draftHash}
          onChange={(e) => setDraftHash(e.target.value as "" | `0x${string}`)}
          className="w-full rounded border border-surface-hi bg-surface px-2 py-1 text-sm"
          aria-label="Edit associated signer"
        >
          <option value="">— none —</option>
          {signerOptions.map((o) => (
            <option key={o.hash} value={o.hash}>
              {o.label} ({shortHash(o.hash)})
            </option>
          ))}
        </select>
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraftNick(peer.nickname);
              setDraftHash(peer.associatedSignerHash ?? "");
              setError(null);
            }}
            className="text-xs text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded bg-accent px-2 py-0.5 text-xs text-accent-fg"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded border border-surface-hi bg-surface-lo p-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">{peer.nickname}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-accent hover:underline"
          >
            edit
          </button>
          <button
            type="button"
            onClick={() => removePeer(peer.address)}
            className="text-xs text-red-400 hover:underline"
          >
            remove
          </button>
        </div>
      </div>
      <div className="font-mono text-xs text-fg-muted">{shortAddr(peer.address)}</div>
      <div className="text-xs text-fg-muted">
        {peer.associatedSignerHash
          ? `signer: ${shortHash(peer.associatedSignerHash)}`
          : "no associated signer"}
      </div>
    </div>
  );
}
