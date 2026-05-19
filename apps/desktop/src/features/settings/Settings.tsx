export function Settings() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="grid grid-cols-2 gap-4">
        <Card title="CKB network" body="Mainnet · embedded light client" />
        <Card title="EVM chains" body="Ethereum, Arbitrum, Optimism, Base" />
        <Card title="Signer transports" body="JoyID, Ledger (CKB), MetaMask, WalletConnect (EVM)" />
        <Card title="Frappe backend" body="Not connected · Phase 4" />
      </div>
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{title}</div>
      <div className="mt-2 text-sm">{body}</div>
    </div>
  );
}
