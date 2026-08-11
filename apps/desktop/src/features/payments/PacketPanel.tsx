import type { PaymentSkeleton } from "@/lib/chains/ckb/tx-builder";
import { CopyButton } from "@/components/clipboard/CopyButton";
import { formatCkb } from "@/lib/format/ckb";
import { Section } from "@/components/ui/Section";

export function PacketPanel({
  packetJson,
  skeleton,
}: {
  packetJson: string;
  skeleton: PaymentSkeleton;
}) {
  return (
    <Section title="5. Transfer packet — hand to each co-signer">
      <textarea
        value={packetJson}
        readOnly
        rows={6}
        className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
      />
      <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
        <div className="tabular-nums">
          in {formatCkb(skeleton.totalIn)} · out {formatCkb(skeleton.totalOut)} · fee{" "}
          {formatCkb(skeleton.fee)} CKB
        </div>
        <CopyButton value={packetJson} label="packet" title="Copy packet + stash in a bin" />
      </div>
    </Section>
  );
}
