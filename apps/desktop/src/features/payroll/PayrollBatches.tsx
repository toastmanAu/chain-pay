export function PayrollBatches() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Payroll batches</h1>
      <p className="text-sm text-fg-muted">
        Each batch is one multisig transaction with one input from treasury and N outputs to payee addresses.
      </p>
      <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
        Phase 2.5 — payroll batch lifecycle: draft → calculated → pending_approval → approved → awaiting_signature →
        broadcasted → confirming → confirmed.
      </div>
    </div>
  );
}
