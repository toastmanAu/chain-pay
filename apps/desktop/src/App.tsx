import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { TreasuryList } from "./features/treasury/TreasuryList";
import { SetupMultisig } from "./features/treasury/SetupMultisig";
import { TreasuryDetail } from "./features/treasury/TreasuryDetail";
import { PayrollBatches } from "./features/payroll/PayrollBatches";
import { PendingPayments } from "./features/payments/PendingPayments";
import { SignPanel } from "./features/sign/SignPanel";
import { Employees } from "./features/employees/Employees";
import { Settings } from "./features/settings/Settings";
import { useSyncStore } from "./stores/sync";

export function App() {
  const startCkb = useSyncStore((s) => s.startCkb);

  useEffect(() => {
    void startCkb("mainnet");
  }, [startCkb]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/treasury" element={<TreasuryList />} />
        <Route path="/treasury/new" element={<SetupMultisig />} />
        <Route path="/treasury/:id" element={<TreasuryDetail />} />
        <Route path="/payroll" element={<PayrollBatches />} />
        <Route path="/payments" element={<PendingPayments />} />
        <Route path="/sign" element={<SignPanel />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
