import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { TreasuryList } from "./features/treasury/TreasuryList";
import { SetupMultisig } from "./features/treasury/SetupMultisig";
import { PayrollBatches } from "./features/payroll/PayrollBatches";
import { PendingPayments } from "./features/payments/PendingPayments";
import { Employees } from "./features/employees/Employees";
import { Settings } from "./features/settings/Settings";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/treasury" element={<TreasuryList />} />
        <Route path="/treasury/new" element={<SetupMultisig />} />
        <Route path="/payroll" element={<PayrollBatches />} />
        <Route path="/payments" element={<PendingPayments />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
