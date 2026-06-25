import { NavLink } from "react-router-dom";
import { LayoutDashboard, Vault, Calendar, FileText, Send, PenLine, Users, Settings as Cog, Wallet } from "lucide-react";
import { useSyncStore, type CkbSyncState } from "@/stores/sync";

const items = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/treasury", icon: Vault, label: "Treasury" },
  { to: "/payroll", icon: Calendar, label: "Payroll" },
  { to: "/invoices", icon: FileText, label: "Invoices" },
  { to: "/payments", icon: Send, label: "Payments" },
  { to: "/send", icon: Wallet, label: "Send" },
  { to: "/sign", icon: PenLine, label: "Sign" },
  { to: "/employees", icon: Users, label: "Employees" },
  { to: "/settings", icon: Cog, label: "Settings" },
];

export function Sidebar() {
  const ckb = useSyncStore((s) => s.ckb);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface-hi bg-surface">
      <div className="border-b border-surface-hi px-5 py-4">
        <div className="text-lg font-semibold tracking-tight">ChainPay</div>
        <div className="text-xs text-fg-muted">v0.1.0 · Phase 1</div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-surface-hi/60 hover:text-fg"
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-surface-hi px-5 py-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-fg-muted">CKB light client</span>
          <span className={statusTone(ckb)}>{statusLabel(ckb)}</span>
        </div>
        {ckb.started ? (
          <div className="mt-1 text-fg-muted tabular-nums">
            tip {ckb.tipBlockNumber.toString()} · peers {ckb.peers}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function statusLabel(ckb: CkbSyncState): string {
  if (ckb.lastError) return "error";
  if (ckb.starting) return "starting";
  if (!ckb.started) return "stopped";
  if (ckb.peers === 0) return "connecting";
  return "running";
}

function statusTone(ckb: CkbSyncState): string {
  if (ckb.lastError) return "text-danger";
  if (ckb.starting) return "text-warn";
  if (!ckb.started) return "text-fg-muted";
  if (ckb.peers === 0) return "text-warn";
  return "text-accent";
}
