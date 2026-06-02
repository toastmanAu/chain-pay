import { useState } from "react";
import { Link } from "react-router-dom";
import type { InvoiceApprovalStatus } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";

interface SectionAction {
  to: string;
  label: string;
}

interface Section {
  status: InvoiceApprovalStatus;
  label: string;
  action: (id: string, batchId?: string) => SectionAction;
}

/** Status values that display a multi-select checkbox. */
const BUNDLE_ELIGIBLE_STATUSES: ReadonlySet<InvoiceApprovalStatus> = new Set(["in-review"]);

const SECTION_ORDER: Section[] = [
  {
    status: "in-review",
    label: "In review",
    action: (id) => ({ to: `/invoices/${id}/review`, label: "Review →" }),
  },
  {
    status: "queued-for-signing",
    label: "Queued for signing",
    action: (_id, batchId) => ({ to: `/payments/${batchId ?? ""}`, label: "Open batch →" }),
  },
  {
    status: "signed",
    label: "Signed",
    action: (_id, batchId) => ({ to: `/payments/${batchId ?? ""}`, label: "View →" }),
  },
  {
    status: "rejected",
    label: "Rejected",
    action: (id) => ({ to: `/invoices/${id}/review`, label: "View →" }),
  },
];

interface InvoiceListProps {
  onSelectionChange?: (selected: Set<string>) => void;
}

export function InvoiceList({ onSelectionChange }: InvoiceListProps = {}) {
  const invoices = useInvoicesStore((s) => s.invoices);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
    onSelectionChange?.(next);
  }

  return (
    <div className="invoice-list">
      {SECTION_ORDER.map((section) => {
        const items = invoices.filter((i) => i.approval.status === section.status);
        const selectable = BUNDLE_ELIGIBLE_STATUSES.has(section.status);
        return (
          <section key={section.status}>
            <h3>
              {section.label} ({items.length})
            </h3>
            <ul>
              {items.map((i) => {
                const a = section.action(i.id, i.batchId);
                return (
                  <li key={i.id}>
                    {selectable && (
                      <input
                        type="checkbox"
                        aria-label={`Select invoice ${i.id}`}
                        checked={selected.has(i.id)}
                        onChange={() => toggle(i.id)}
                      />
                    )}
                    <span>{i.invoice.invoice_number ?? "—"}</span>
                    <span>{i.invoice.payee.display_name}</span>
                    <span>
                      {i.invoice.total.toFixed(2)} {i.invoice.currency}
                    </span>
                    <Link to={a.to}>
                      <button type="button">{a.label}</button>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
