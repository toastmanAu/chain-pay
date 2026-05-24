import { useState } from "react";
import { usePeerBookStore } from "@/stores/peer-book";
import { AddPeerForm } from "./peer-book-rows/AddPeerForm";
import { PeerRow } from "./peer-book-rows/PeerRow";

export function PeerBookSection() {
  const peers = usePeerBookStore((s) => s.peers);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <section
      className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5"
      aria-label="Peer book"
    >
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-fg-muted">Peer book</div>
          <p className="mt-1 text-sm text-fg-muted">
            Pair comm-channel peers and map each to the multisig signer it relays
            for. Operators send packets to mapped peers; signatures flow back
            into the matching PayrollBatch automatically.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="rounded bg-accent px-3 py-1 text-sm text-accent-fg"
          >
            + Add peer
          </button>
        )}
      </header>

      {showAdd && <AddPeerForm onClose={() => setShowAdd(false)} />}

      {peers.length === 0 && !showAdd && (
        <p className="text-sm italic text-fg-muted">
          No peers paired yet. Add the first one to start routing signatures via comm.
        </p>
      )}

      <div className="space-y-2">
        {peers.map((p) => (
          <PeerRow key={p.address} peer={p} />
        ))}
      </div>
    </section>
  );
}
