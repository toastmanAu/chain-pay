import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { TreasuryList } from "./features/treasury/TreasuryList";
import { SetupMultisig } from "./features/treasury/SetupMultisig";
import { TreasuryDetail } from "./features/treasury/TreasuryDetail";
import { PayrollBatches } from "./features/payroll/PayrollBatches";
import { PayPanel } from "./features/payments/PayPanel";
import { SignPanel } from "./features/sign/SignPanel";
import { Employees } from "./features/employees/Employees";
import { Settings } from "./features/settings/Settings";
import { useSyncStore } from "./stores/sync";
import { useNetworkConfigStore } from "./stores/network-config";
import { lightClient } from "./lib/light-client/client";

export function App() {
  const startCkb = useSyncStore((s) => s.startCkb);
  const broadcastRpcUrl = useNetworkConfigStore((s) => s.broadcastRpcUrl);

  useEffect(() => {
    // Sync the persisted broadcast-RPC override to the LightClientHost on
    // every change. The host's setter is idempotent.
    lightClient().setBroadcastRpcUrl(broadcastRpcUrl);
  }, [broadcastRpcUrl]);

  useEffect(() => {
    // Default to testnet for the Phase 2 smoke-test loop. A network selector
    // belongs in Settings (Phase 2.5+) — switching at runtime needs to stop
    // the existing LightClient, swap the IndexedDB scope, then re-subscribe
    // every watched lock under the new network.
    void startCkb("testnet");
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
        <Route path="/payments" element={<PayPanel />} />
        <Route path="/sign" element={<SignPanel />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
