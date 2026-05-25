import type { CkbNetwork } from "@/lib/light-client/network-configs";

interface NetworkRestartModalProps {
  fromNetwork: CkbNetwork;
  toNetwork: CkbNetwork;
  onCancel: () => void;
  onConfirm: () => void;
}

export function NetworkRestartModal({
  fromNetwork,
  toNetwork,
  onCancel,
  onConfirm,
}: NetworkRestartModalProps): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl border border-neutral-700">
        <h2 className="text-lg font-semibold mb-3">Restart required</h2>
        <p className="text-sm text-neutral-300 mb-3">
          ChainPay will quit. Re-launch the app to finish switching from{" "}
          <strong>{fromNetwork}</strong> to <strong>{toNetwork}</strong>. Your
          light-client chain data for <strong>{fromNetwork}</strong> will be
          wiped on next launch (this clears only on-chain header cache;
          treasuries, payees, and payroll batches are preserved).
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-neutral-600 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded bg-amber-600 hover:bg-amber-500 font-medium"
          >
            Quit &amp; Restart Later
          </button>
        </div>
      </div>
    </div>
  );
}
