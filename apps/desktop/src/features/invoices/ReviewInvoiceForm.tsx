import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm, type SubmitHandler } from "react-hook-form";
import { InvoiceSchema, type InvoiceRecord } from "@chain-pay/shared";
import { approveAndQueue } from "@/lib/invoices/approve-and-queue";
import { useInvoicesStore } from "@/stores/invoices";
import { useTreasuryStore } from "@/stores/treasury";
import { useInvoiceDraft } from "./hooks/useInvoiceDraft";
import { useExtractionLive } from "./hooks/useExtractionLive";
import { extractionService } from "@/lib/invoices/extraction";
import { fileFromStorage } from "@/lib/invoices/file-storage";

const CONFIDENCE_THRESHOLD = 0.85;

interface FormShape {
  vendor: string;
  taxId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  notes: string;
}

interface EditEntry {
  field: string;
  before: unknown;
  after: unknown;
}

const CURRENT_USER_ID = "operator";

function fromInvoice(inv: InvoiceRecord): FormShape {
  return {
    vendor: inv.invoice.payee.display_name,
    taxId: inv.invoice.payee.tax_id ?? "",
    invoiceNumber: inv.invoice.invoice_number ?? "",
    issueDate: inv.invoice.issue_date ?? "",
    dueDate: inv.invoice.due_date ?? "",
    currency: inv.invoice.currency,
    subtotal: inv.invoice.subtotal ?? 0,
    taxTotal: inv.invoice.tax_total ?? 0,
    total: inv.invoice.total,
    notes: inv.invoice.notes ?? "",
  };
}

function toInvoice(prev: InvoiceRecord, form: FormShape): InvoiceRecord {
  const payee: InvoiceRecord["invoice"]["payee"] = {
    kind: prev.invoice.payee.kind,
    display_name: form.vendor,
  };
  if (prev.invoice.payee.id !== undefined && prev.invoice.payee.id !== null) {
    payee.id = prev.invoice.payee.id;
  }
  if (form.taxId) payee.tax_id = form.taxId;

  const body: InvoiceRecord["invoice"] = {
    flow: prev.invoice.flow,
    payee,
    currency: form.currency,
    total: form.total,
  };
  if (form.invoiceNumber) body.invoice_number = form.invoiceNumber;
  if (form.issueDate) body.issue_date = form.issueDate;
  if (form.dueDate) body.due_date = form.dueDate;
  if (form.subtotal) body.subtotal = form.subtotal;
  if (form.taxTotal) body.tax_total = form.taxTotal;
  if (form.notes) body.notes = form.notes;

  return { ...prev, invoice: body };
}

function diffEdits(before: InvoiceRecord, after: InvoiceRecord): EditEntry[] {
  const out: EditEntry[] = [];
  const fields: Array<keyof InvoiceRecord["invoice"]> = [
    "invoice_number",
    "issue_date",
    "due_date",
    "currency",
    "subtotal",
    "tax_total",
    "total",
    "notes",
  ];
  for (const f of fields) {
    if (before.invoice[f] !== after.invoice[f]) {
      out.push({
        field: `invoice.${f}`,
        before: before.invoice[f] ?? null,
        after: after.invoice[f] ?? null,
      });
    }
  }
  if (before.invoice.payee.display_name !== after.invoice.payee.display_name) {
    out.push({
      field: "invoice.payee.display_name",
      before: before.invoice.payee.display_name,
      after: after.invoice.payee.display_name,
    });
  }
  return out;
}

/** Strip ChainPay-local wrapper fields before validating against the durable schema. */
function toSchemaShape(rec: InvoiceRecord): Omit<InvoiceRecord, "id" | "createdAt" | "updatedAt"> {
  // Also strip StoredInvoiceRecord-only runtime fields (batchId, extractionStatus,
  // extractionError) so they don't fail InvoiceSchema's .strict() check.
  const { id: _id, createdAt: _c, updatedAt: _u, batchId: _b, extractionStatus: _es, extractionError: _ee, ...rest } = rec as InvoiceRecord & { batchId?: unknown; extractionStatus?: unknown; extractionError?: unknown };
  return rest;
}

export function ReviewInvoiceForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // findById is a getter on the store; subscribe to invoices and look up in body
  // to avoid React 19 instability with computed selectors.
  const invoices = useInvoicesStore((s) => s.invoices);
  const invoice = id ? invoices.find((i) => i.id === id) : undefined;
  const markInReview = useInvoicesStore((s) => s.markInReview);
  const markRejected = useInvoicesStore((s) => s.markRejected);
  const appendEdit = useInvoicesStore((s) => s.appendEdit);
  // Select raw arrays from store, filter in body (React 19 stability trap).
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const activeTreasuryId = useTreasuryStore((s) => s.activeTreasuryId);
  const treasury = treasuries.find((t) => t.id === activeTreasuryId);

  const { update, clear } = useInvoiceDraft(id ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const live = useExtractionLive(id ?? "");
  const isExtracting = live.status === "running" || live.status === "pending";
  const isFailed = live.status === "failed";

  async function onRetry() {
    if (!invoice) return;
    const file = await fileFromStorage(invoice.intake.raw_file.storage_uri);
    if (!file) return;
    extractionService().enqueue(id ?? "", file);
  }

  function chipFor(field: string) {
    const c = live.confidences[field];
    if (c === undefined || c >= CONFIDENCE_THRESHOLD) return null;
    return (
      <span className="text-xs text-amber-600 ml-2">
        Low confidence — please check
      </span>
    );
  }

  const form = useForm<FormShape>(
    invoice ? { defaultValues: fromInvoice(invoice) } : {},
  );

  useEffect(() => {
    if (invoice && invoice.approval.status === "draft") {
      markInReview(invoice.id);
    }
    // Only fire on id/status transition; markInReview is stable.
  }, [invoice?.id, invoice?.approval.status, markInReview, invoice]);

  useEffect(() => {
    if (!invoice) return;
    const sub = form.watch((values) => {
      update(toInvoice(invoice, values as FormShape));
    });
    return () => sub.unsubscribe();
  }, [form, invoice, update]);

  if (!invoice) return <p>Invoice not found.</p>;

  const onApprove: SubmitHandler<FormShape> = (values) => {
    setSubmitError(null);
    if (!invoice) return;
    if (!treasury) {
      setSubmitError("No active treasury — open Treasury Settings");
      return;
    }
    const next = toInvoice(invoice, values);
    // Schema validation against the durable shape (id/createdAt/updatedAt are
    // local wrapper fields and not part of the durable Invoice schema).
    const parsed = InvoiceSchema.safeParse(toSchemaShape(next));
    if (!parsed.success) {
      const totalIssue = parsed.error.issues.find(
        (i) => i.path.join(".") === "invoice.total",
      );
      setSubmitError(
        totalIssue ? "Total required (cannot be 0)" : (parsed.error.issues[0]?.message ?? "Validation failed"),
      );
      return;
    }
    // Zod's schema accepts 0 since `total: z.number()` has no min — explicit check.
    if (next.invoice.total === 0) {
      setSubmitError("Total required (cannot be 0)");
      return;
    }
    for (const edit of diffEdits(invoice, next)) {
      appendEdit(invoice.id, { ...edit, edited_by: CURRENT_USER_ID });
    }
    try {
      const { batchId } = approveAndQueue(next, treasury, CURRENT_USER_ID);
      clear();
      // PayPanel reads autoSelectBatchId from navigate state on mount and
      // pre-selects the new batch. Route is `/payments` (no path param).
      navigate("/payments", { state: { autoSelectBatchId: batchId } });
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Approve failed");
    }
  };

  function confirmReject() {
    if (!invoice) return;
    markRejected(invoice.id, rejectReason || "no reason given");
    setRejecting(false);
  }

  return (
    <div className="review-invoice-form">
      <div className="pdf-preview">
        <p>PDF: {invoice.intake.raw_file.filename}</p>
      </div>

      {isExtracting && (
        <div className="rounded bg-blue-50 p-2 text-sm">Extracting…</div>
      )}
      {isFailed && (
        <div className="rounded bg-red-50 p-2 text-sm">
          Auto-extraction failed: {live.error ?? "unknown error"}.{" "}
          <button type="button" onClick={onRetry} className="underline">
            Retry
          </button>
        </div>
      )}

      <form onSubmit={form.handleSubmit(onApprove)}>
        <label>
          Vendor {chipFor("payee_display_name")}
          <input {...form.register("vendor")} />
        </label>
        <label>
          Tax ID <input {...form.register("taxId")} />
        </label>
        <label>
          Invoice # {chipFor("invoice_number")}
          <input {...form.register("invoiceNumber")} />
        </label>
        <label>
          Issue date {chipFor("issue_date")}
          <input type="date" {...form.register("issueDate")} />
        </label>
        <label>
          Due date {chipFor("due_date")}
          <input type="date" {...form.register("dueDate")} />
        </label>
        <label>
          Currency {chipFor("currency")}
          <input {...form.register("currency")} />
        </label>
        <label>
          Subtotal{" "}
          <input
            type="number"
            step="0.01"
            {...form.register("subtotal", { valueAsNumber: true })}
          />
        </label>
        <label>
          Tax{" "}
          <input
            type="number"
            step="0.01"
            {...form.register("taxTotal", { valueAsNumber: true })}
          />
        </label>
        <label>
          Total {chipFor("total")}
          <input
            type="number"
            step="0.01"
            {...form.register("total", { valueAsNumber: true })}
          />
        </label>
        <label>
          Notes <textarea {...form.register("notes")} />
        </label>

        {submitError && <p className="error">{submitError}</p>}

        <button type="button" onClick={() => clear()}>
          Save as draft
        </button>
        <button type="button" onClick={() => setRejecting(true)}>
          Reject
        </button>
        <button type="submit">Approve &amp; queue →</button>
      </form>

      {rejecting && (
        <div className="reject-modal">
          <label>
            Rejection reason{" "}
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
          <button type="button" onClick={confirmReject}>
            Confirm reject
          </button>
          <button type="button" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
