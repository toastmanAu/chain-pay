export function Employees() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Employees &amp; contractors</h1>
      <p className="text-sm text-fg-muted">
        Payee profiles: fiat salary, preferred asset, preferred network, wallet address, optional split payments.
      </p>
      <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
        Phase 2.5 — wired against Frappe HR Employee DocType + custom <code>Crypto Payee Profile</code>.
      </div>
    </div>
  );
}
