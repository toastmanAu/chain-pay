import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InvoiceFlow, InvoiceRecord, VendorProfile } from "@chain-pay/shared";
import { extractionService } from "@/lib/invoices/extraction";
import { storeBlob } from "@/lib/invoices/file-storage";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayeesStore } from "@/stores/payees";
import { VendorPicker } from "./VendorPicker";

const ACCEPT_MIME = ["application/pdf", "image/png", "image/jpeg"];
const MAX_BYTES = 50 * 1024 * 1024;

export function NewInvoiceForm() {
  const navigate = useNavigate();
  const addInvoice = useInvoicesStore((s) => s.addInvoice);
  const [flow, setFlow] = useState<InvoiceFlow>("one-off-vendor");
  const [vendor, setVendor] = useState<VendorProfile | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onFile(picked: File | undefined) {
    setFileError(null);
    setFile(null);
    if (!picked) return;
    if (!ACCEPT_MIME.includes(picked.type)) {
      setFileError("Only PDF, PNG, JPG accepted");
      return;
    }
    if (picked.size > MAX_BYTES) {
      setFileError("File must be under 50 MB");
      return;
    }
    setFile(picked);
  }

  const canContinue = !!file && (flow === "one-off-vendor" ? !!vendor : !!employeeId);

  async function onContinue() {
    if (!canContinue || !file) return;
    setSubmitting(true);
    try {
      const { uri, sha256 } = await storeBlob(file);
      const now = new Date().toISOString();
      const invoice: InvoiceRecord = {
        id: `inv_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        schema_version: "0.1.0",
        intake: {
          source: "manual-upload",
          received_at: now,
          raw_file: {
            sha256,
            mime_type: file.type,
            byte_size: file.size,
            filename: file.name,
            storage_uri: uri,
          },
        },
        invoice: {
          flow,
          payee:
            flow === "one-off-vendor"
              ? {
                  kind: "vendor",
                  id: vendor!.id,
                  display_name: vendor!.displayName,
                  ...(vendor!.taxId ? { tax_id: vendor!.taxId } : {}),
                }
              : { kind: "employee", id: employeeId!, display_name: "" },
          currency: "AUD",
          total: 0,
        },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "draft" },
      };
      addInvoice(invoice);
      extractionService().enqueue(invoice.id, file);
      navigate(`/invoices/${invoice.id}/review`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="new-invoice-form">
      <h2>New invoice</h2>
      <fieldset>
        <legend>Flow</legend>
        <label>
          <input
            type="radio"
            name="flow"
            checked={flow === "one-off-vendor"}
            onChange={() => setFlow("one-off-vendor")}
          />{" "}
          One-off vendor
        </label>
        <label>
          <input
            type="radio"
            name="flow"
            checked={flow === "employee-payment"}
            onChange={() => setFlow("employee-payment")}
          />{" "}
          Employee payment
        </label>
      </fieldset>

      {flow === "one-off-vendor" ? (
        <VendorPicker onSelect={setVendor} />
      ) : (
        <EmployeeSelect onSelect={setEmployeeId} />
      )}

      <label htmlFor="invoice-file">Upload PDF</label>
      <input
        id="invoice-file"
        type="file"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {fileError && <p className="error">{fileError}</p>}
      {file && (
        <p>
          {file.name} {Math.round(file.size / 1024)}KB
        </p>
      )}

      <button type="button" disabled={!canContinue || submitting} onClick={onContinue}>
        Continue
      </button>
    </div>
  );
}

interface EmployeeSelectProps {
  onSelect: (id: string) => void;
}

function EmployeeSelect({ onSelect }: EmployeeSelectProps) {
  const allPayees = usePayeesStore((s) => s.payees);
  const payees = allPayees.filter((p) => p.active);
  return (
    <label>
      Employee
      <select defaultValue="" onChange={(e) => onSelect(e.target.value)}>
        <option value="" disabled>
          Pick an employee…
        </option>
        {payees.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
