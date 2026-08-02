import { Link } from "react-router-dom";
import { formatEther } from "viem";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { useTreasuryStore } from "@/stores/treasury";

export function ApprovalQueue() {
  const transactions = usePendingTransactionsStore((state) => state.transactions);
  const treasuries = useTreasuryStore((state) => state.treasuries);
  const evmTransactions = transactions.filter((transaction) => transaction.chain.startsWith("evm:"));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-fg-muted">Safe payment approval, execution, and confirmation.</p>
      </header>
      {evmTransactions.length === 0 ? (
        <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
          No Safe payments are waiting for approval.
        </div>
      ) : (
        <ul className="space-y-2">
          {evmTransactions.map((transaction) => {
            const treasury = treasuries.find((candidate) => candidate.id === transaction.treasuryId);
            const output = transaction.outputs[0];
            return (
              <li key={transaction.id} className="rounded-lg border border-surface-hi bg-surface p-4">
                <Link to={`/approvals/${transaction.id}`} className="block">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium hover:text-accent">{treasury?.label ?? "Unknown Safe"}</span>
                    <span className="rounded bg-surface-hi px-2 py-0.5 text-xs text-fg-muted">
                      {stateLabel(transaction.state)}
                    </span>
                  </div>
                  {output ? (
                    <p className="mt-2 text-sm">
                      {formatEther(BigInt(output.amount.value))} ETH → {shortAddress(output.to)}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-fg-muted">
                    {transaction.signatures.length} signature{transaction.signatures.length === 1 ? "" : "s"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function stateLabel(state: string): string {
  if (state === "ready_to_broadcast") return "threshold met";
  if (state === "broadcasted" || state === "confirming") return "confirming";
  if (state === "confirmed") return "confirmed";
  if (state === "posting") return "posting";
  if (state === "posted") return "posted";
  if (state === "post_failed") return "accounting failed";
  if (state === "failed") return "failed";
  return "awaiting signature";
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}
