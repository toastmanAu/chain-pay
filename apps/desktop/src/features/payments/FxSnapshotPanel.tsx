import type { FxQuote } from "@chain-pay/shared";
import { formatFxQuote } from "@/lib/fx/coingecko";

export function FxSnapshotPanel({
  quotes,
  loading,
  error,
  takenAtLabel,
  onRefresh,
}: {
  quotes: FxQuote[];
  loading: boolean;
  error: string | null;
  takenAtLabel: string | null;
  onRefresh: () => void;
}) {
  if (loading) {
    return <p className="text-xs text-fg-muted">Fetching CKB price from CoinGecko…</p>;
  }
  if (error) {
    return (
      <p className="text-xs text-danger">
        FX fetch failed: {error}. Enter amounts manually or{" "}
        <button type="button" onClick={onRefresh} className="underline">
          retry
        </button>
        .
      </p>
    );
  }
  if (quotes.length === 0) return null;
  return (
    <div className="flex items-center justify-between text-xs text-fg-muted">
      <span>
        FX snapshot: {quotes.map((q) => formatFxQuote(q)).join(" · ")} ·{" "}
        <span className="text-fg">CoinGecko</span>
        {takenAtLabel ? <> · {takenAtLabel}</> : null}
      </span>
      <button type="button" onClick={onRefresh} className="underline hover:text-fg">
        re-fetch
      </button>
    </div>
  );
}
