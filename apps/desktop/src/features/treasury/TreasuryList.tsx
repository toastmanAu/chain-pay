import { Link } from "react-router-dom";

export function TreasuryList() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Treasury</h1>
          <p className="text-sm text-fg-muted">Multisig wallets for payroll funding.</p>
        </div>
        <Link
          to="/treasury/new"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          New multisig
        </Link>
      </div>
      <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
        No treasuries yet. Create a CKB or EVM multisig to get started.
      </div>
    </div>
  );
}
