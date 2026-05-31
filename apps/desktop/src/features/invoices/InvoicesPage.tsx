import { useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useTreasuryStore } from "@/stores/treasury";
import { canBundle } from "@/lib/invoices/bundling";
import { routeInvoicesToBatch } from "@/lib/invoices/route-to-batch";
import { InvoiceList } from "./InvoiceList";
import { NewInvoiceForm } from "./NewInvoiceForm";
import { ReviewInvoiceForm } from "./ReviewInvoiceForm";

const CURRENT_USER_ID = "operator";

export function InvoicesPage() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const invoices = useInvoicesStore((s) => s.invoices);
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const activeTreasuryId = useTreasuryStore((s) => s.activeTreasuryId);
  const treasury = treasuries.find((t) => t.id === activeTreasuryId);
  const navigate = useNavigate();

  const selected = invoices.filter((i) => selectedIds.has(i.id));
  const showCta = selected.length >= 2;
  const eligibility = showCta ? canBundle(selected) : { ok: false as const, reason: "" };

  function onBundle() {
    if (!eligibility.ok || !treasury) return;
    const batch = routeInvoicesToBatch(selected, treasury);
    usePayrollBatchesStore.getState().addBatch(batch);
    for (const inv of selected) {
      useInvoicesStore.getState().markQueuedForSigning(inv.id, batch.id, CURRENT_USER_ID);
    }
    setSelectedIds(new Set());
    navigate(`/payments/${batch.id}`);
  }

  return (
    <div className="invoices-page">
      <header>
        <h1>Invoices</h1>
        <Link to="/invoices/new"><button type="button">+ New invoice</button></Link>
      </header>
      {showCta && (
        <div className="bundle-toolbar">
          <button
            type="button"
            disabled={!eligibility.ok}
            onClick={onBundle}
            title={eligibility.ok ? "" : eligibility.reason}
          >
            Bundle into batch ({selected.length})
          </button>
          {!eligibility.ok && (
            <span className="bundle-toolbar__reason">{eligibility.reason}</span>
          )}
        </div>
      )}
      <Routes>
        <Route index element={<InvoiceList onSelectionChange={setSelectedIds} />} />
        <Route path="new" element={<NewInvoiceForm />} />
        <Route path=":id/review" element={<ReviewInvoiceForm />} />
      </Routes>
    </div>
  );
}
