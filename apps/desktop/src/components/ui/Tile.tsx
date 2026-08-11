interface TileProps {
  label: string;
  value: string;
  /** Optional secondary caption under the value. Omitted entirely when not provided. */
  hint?: string;
  /** Value text color. Defaults to the neutral foreground color. */
  tone?: "default" | "accent" | "danger";
}

/**
 * Shared stat tile: uppercase label, large tabular-nums value, optional hint.
 *
 * This is the union of three call-site-local `Tile` components
 * (`Dashboard.tsx`, `TreasuryDetail.tsx`, `SafeApprovalDetail.tsx`) that
 * were consolidated here. `hint` and `tone` are optional so the simplest
 * call site (label/value only) is unaffected; markup/sizing follows the
 * richer `Dashboard`/`TreasuryDetail` versions (`p-5`, `text-2xl` value) —
 * see task-7-report.md for the resulting visual diff at the
 * `SafeApprovalDetail` call site, which previously used smaller `p-4`/
 * `text-lg` styling.
 */
export function Tile({ label, value, hint, tone = "default" }: TileProps) {
  const valueClass = tone === "accent" ? "text-accent" : tone === "danger" ? "text-danger" : "text-fg";
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {hint !== undefined ? <div className="mt-1 text-xs text-fg-muted">{hint}</div> : null}
    </div>
  );
}
