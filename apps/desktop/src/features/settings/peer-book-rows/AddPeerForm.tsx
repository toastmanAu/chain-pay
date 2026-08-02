import { useMemo, useState } from "react";
import { usePeerBookStore } from "@/stores/peer-book";
import { useTreasuryStore } from "@/stores/treasury";
import { peerHashFromAddress } from "@/lib/comm/peer-hash";
import { isMultisigTreasury } from "@chain-pay/shared";

interface SignerOption {
  hash: `0x${string}`;
  label: string; // "Treasury name — slot N"
}

function enumerateSignerHashes(
  treasuries: ReturnType<typeof useTreasuryStore.getState>["treasuries"],
): SignerOption[] {
  const out: SignerOption[] = [];
  for (const t of treasuries) {
    if (!isMultisigTreasury(t) || !("pubkeyHashes" in t.multisig)) continue;
    t.multisig.pubkeyHashes.forEach((hash, i) => {
      out.push({ hash, label: `${t.label} — slot ${i}` });
    });
  }
  return out;
}

interface AddPeerFormProps {
  onClose: () => void;
}

export function AddPeerForm({ onClose }: AddPeerFormProps) {
  const addPeer = usePeerBookStore((s) => s.addPeer);
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const signerOptions = useMemo(() => enumerateSignerHashes(treasuries), [treasuries]);

  const [nickname, setNickname] = useState("");
  const [address, setAddress] = useState("");
  const [signerHash, setSignerHash] = useState<"" | `0x${string}`>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = nickname.trim().length > 0 && address.trim().length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const candidateHash = await peerHashFromAddress(address.trim());
      addPeer(
        {
          nickname: nickname.trim(),
          address: address.trim(),
          pairedAt: Date.now(),
          ...(signerHash !== "" ? { associatedSignerHash: signerHash } : {}),
        },
        candidateHash,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-surface-hi bg-surface-lo p-4"
      aria-label="Add peer"
    >
      <div>
        <label className="block text-xs uppercase tracking-wide text-fg-muted" htmlFor="peer-nickname">
          Nickname
        </label>
        <input
          id="peer-nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="mt-1 w-full rounded border border-surface-hi bg-surface px-2 py-1 text-sm"
          placeholder="Alice"
        />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wide text-fg-muted" htmlFor="peer-address">
          Address (ckt1q… or ckb1q…)
        </label>
        <input
          id="peer-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="mt-1 w-full rounded border border-surface-hi bg-surface px-2 py-1 font-mono text-xs"
          placeholder="ckt1qzycfa…"
        />
      </div>

      <div>
        <label
          className="block text-xs uppercase tracking-wide text-fg-muted"
          htmlFor="peer-associated-signer"
        >
          Associated signer (optional)
        </label>
        <select
          id="peer-associated-signer"
          value={signerHash}
          onChange={(e) => setSignerHash(e.target.value as "" | `0x${string}`)}
          className="mt-1 w-full rounded border border-surface-hi bg-surface px-2 py-1 text-sm"
        >
          <option value="">— none —</option>
          {signerOptions.map((o) => (
            <option key={o.hash} value={o.hash}>
              {o.label} ({o.hash.slice(0, 10)}…)
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1 text-sm text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-accent px-3 py-1 text-sm text-accent-fg disabled:opacity-50"
        >
          {submitting ? "Adding…" : "Add peer"}
        </button>
      </div>
    </form>
  );
}
