import { useState } from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import {
  exportCompliance,
  type ComplianceFilters,
  type ComplianceSaveResult,
} from "@/lib/accounting/ipc";

type ExportFormat = "csv" | "pdf";

export function complianceExportError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Compliance export failed.";
}

export function ComplianceExport({
  requestExport = exportCompliance,
}: {
  requestExport?: (
    filters: ComplianceFilters,
    format: ExportFormat,
  ) => Promise<ComplianceSaveResult>;
}) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [chain, setChain] = useState<ComplianceFilters["chain"] | "">("");
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runExport = async (format: ExportFormat) => {
    setNotice(null);
    setError(null);
    if (fromDate && toDate && fromDate > toDate) {
      setError("From date cannot be after to date.");
      return;
    }
    setBusy(format);
    try {
      const result = await requestExport(
        {
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          ...(chain ? { chain } : {}),
        },
        format,
      );
      if (!result.canceled) {
        setNotice(
          `Saved ${result.rowCount ?? 0} payment ${result.rowCount === 1 ? "line" : "lines"} to ${result.filePath ?? "the selected file"}. SHA-256: ${result.sha256 ?? "unavailable"}`,
        );
      }
    } catch (cause) {
      setError(complianceExportError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Compliance exports</h1>
        <p className="mt-1 max-w-3xl text-sm text-fg-muted">
          Download audit evidence assembled by ERPNext from submitted payment records and
          their Journal Entries. Missing fields in older records are reported as unavailable,
          never estimated.
        </p>
      </header>

      <section className="space-y-5 rounded-lg border border-surface-hi bg-surface p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-fg-muted">From date</span>
            <input
              aria-label="From date"
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => setFromDate(event.target.value)}
              className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-fg-muted">To date</span>
            <input
              aria-label="To date"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
              className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-fg-muted">Network</span>
            <select
              aria-label="Network"
              value={chain}
              onChange={(event) => setChain(event.target.value as typeof chain)}
              className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2"
            >
              <option value="">All supported networks</option>
              <option value="ckb:mainnet">CKB mainnet</option>
              <option value="ckb:testnet">CKB testnet</option>
              <option value="evm:11155111">Ethereum Sepolia</option>
              <option value="sol:devnet">Solana devnet</option>
              <option value="sol:mainnet">Solana mainnet</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void runExport("csv")}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            <FileSpreadsheet size={16} />
            {busy === "csv" ? "Preparing CSV…" : "Export CSV"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void runExport("pdf")}
            className="inline-flex items-center gap-2 rounded-md border border-surface-hi px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            <FileText size={16} />
            {busy === "pdf" ? "Preparing PDF…" : "Export printable PDF"}
          </button>
        </div>

        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {notice ? (
          <div role="status" className="flex items-start gap-2 rounded-md bg-bg p-3 text-sm">
            <Download className="mt-0.5 shrink-0 text-accent" size={16} />
            <span className="break-all">{notice}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
