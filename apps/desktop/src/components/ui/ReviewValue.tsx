/** Labeled value cell used in transaction review grids. Single source; verbatim from TreasuryDetail.tsx. */
export function ReviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-surface-hi p-3">
      <div className="text-fg-muted">{label}</div>
      <div className="mt-1 font-medium tabular-nums">{value}</div>
    </div>
  );
}
