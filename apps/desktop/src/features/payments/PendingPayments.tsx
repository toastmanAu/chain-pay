export function PendingPayments() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Pending payments</h1>
      <p className="text-sm text-fg-muted">
        Partial-signature collection inbox. Each row shows: tx digest, signatures collected vs threshold, your action
        (sign / approve / reject).
      </p>
      <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">Phase 2 / 3.</div>
    </div>
  );
}
