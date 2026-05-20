import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addressPayloadFromString } from "@ckb-ccc/core/advanced";
import { hashTypeFrom, hexFrom, Script } from "@ckb-ccc/core";
import type { CkbMultisig, Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import {
  buildPaymentSkeleton,
  type PaymentSkeleton,
} from "@/lib/chains/ckb/tx-builder";
import {
  encodeTransferPacket,
  treasurySighashDigest,
} from "@/lib/chains/ckb/transfer-packet";
import {
  mergeSignatures,
  type PartialSignature,
} from "@/lib/chains/ckb/merge-signatures";

const SHANNONS_PER_CKB = 100_000_000n;
const DEFAULT_FEE_RATE = 1000n;

interface RecipientRow {
  address: string;
  amountCkb: string;
}

interface SignatureRow {
  slotIndex: number;
  signature: string;
}

type Phase = "draft" | "packet-ready" | "broadcast-ready" | "broadcasted";

export function PayPanel() {
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const ckbSync = useSyncStore((s) => s.ckb);

  const ckbTreasuries = treasuries.filter((t) => t.multisig.chain.startsWith("ckb:"));

  const [treasuryId, setTreasuryId] = useState<string>(ckbTreasuries[0]?.id ?? "");
  const [recipients, setRecipients] = useState<RecipientRow[]>([{ address: "", amountCkb: "" }]);
  const [feeRate, setFeeRate] = useState(DEFAULT_FEE_RATE.toString());
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>("draft");
  const [skeleton, setSkeleton] = useState<PaymentSkeleton | null>(null);
  const [packetJson, setPacketJson] = useState<string>("");
  const [sigs, setSigs] = useState<SignatureRow[]>([]);
  const [broadcastedTxHash, setBroadcastedTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const treasury = ckbTreasuries.find((t) => t.id === treasuryId);
  const multisig = treasury?.multisig as CkbMultisig | undefined;
  const cfg = useMemo<CkbMultisigConfig | null>(() => {
    if (!multisig) return null;
    return {
      s: 0,
      r: 0,
      m: multisig.m,
      n: multisig.n,
      pubkeyHashes: multisig.pubkeyHashes,
      ...(multisig.since !== undefined ? { since: multisig.since } : {}),
    };
  }, [multisig]);

  const handleBuild = async () => {
    if (!cfg || !multisig) return;
    setError(null);
    setBusy(true);
    try {
      const treasuryScript = Script.from(treasuryLockScript(cfg));
      const parsedRecipients = recipients.map((r, i) => {
        const lock = lockFromAddress(r.address.trim());
        const capacity = ckbToShannons(r.amountCkb);
        if (capacity === null) throw new Error(`Recipient ${i + 1}: amount must be a positive number`);
        return { lock, capacity };
      });
      const cells = await lightClient().listCellsForLock(treasuryScript);
      if (cells.length === 0) {
        throw new Error(
          "no cells found for this treasury — fund the address first, then wait for sync",
        );
      }
      const result = buildPaymentSkeleton({
        treasuryConfig: cfg,
        treasuryScript,
        recipients: parsedRecipients,
        availableCells: cells,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        feeRateShannonsPerByte: BigInt(feeRate),
      });
      const json = encodeTransferPacket({
        skeleton: result,
        treasuryConfig: cfg,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setSkeleton(result);
      setPacketJson(json);
      setSigs(
        Array.from({ length: cfg.m }, (_, i) => ({ slotIndex: i, signature: "" })),
      );
      setPhase("packet-ready");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBroadcast = async () => {
    if (!cfg || !skeleton) return;
    setError(null);
    setBusy(true);
    try {
      const partials: PartialSignature[] = sigs.map((s) => {
        if (!s.signature.trim()) throw new Error("All signature slots must be filled");
        return { slotIndex: s.slotIndex, signature: s.signature.trim() };
      });
      const digest = treasurySighashDigest(skeleton.tx);
      mergeSignatures(skeleton.tx, cfg, digest, partials);
      const txHash = await lightClient().broadcastTransaction(skeleton.tx);
      setBroadcastedTxHash(txHash);
      setPhase("broadcasted");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPhase("draft");
    setSkeleton(null);
    setPacketJson("");
    setSigs([]);
    setBroadcastedTxHash(null);
    setError(null);
  };

  if (ckbTreasuries.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Send payment</h1>
        <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
          No CKB treasuries yet.{" "}
          <Link to="/treasury/new" className="text-accent hover:underline">
            Create a multisig
          </Link>{" "}
          to get started.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Send payment</h1>
        <p className="text-sm text-fg-muted">
          Build a payment from a multisig treasury, hand the packet to co-signers, paste their
          signatures back, then broadcast through the embedded light client.
        </p>
      </header>

      <Section title="1. Treasury">
        <select
          value={treasuryId}
          onChange={(e) => {
            setTreasuryId(e.target.value);
            reset();
          }}
          className={inputCls}
        >
          {ckbTreasuries.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({(t.multisig as CkbMultisig).m}-of-{(t.multisig as CkbMultisig).n})
            </option>
          ))}
        </select>
        {multisig ? (
          <div className="mt-2 break-all font-mono text-xs text-fg-muted">{multisig.address}</div>
        ) : null}
      </Section>

      {phase === "draft" ? (
        <DraftForm
          recipients={recipients}
          setRecipients={setRecipients}
          feeRate={feeRate}
          setFeeRate={setFeeRate}
          label={label}
          setLabel={setLabel}
          onBuild={handleBuild}
          busy={busy}
          syncReady={ckbSync.started && ckbSync.peers > 0}
        />
      ) : null}

      {phase !== "draft" && skeleton && cfg ? (
        <PacketPanel
          packetJson={packetJson}
          skeleton={skeleton}
        />
      ) : null}

      {(phase === "packet-ready" || phase === "broadcast-ready") && cfg && multisig ? (
        <SignaturePanel
          cfg={cfg}
          sigs={sigs}
          setSigs={setSigs}
          onBroadcast={handleBroadcast}
          busy={busy}
        />
      ) : null}

      {phase === "broadcasted" && broadcastedTxHash ? (
        <BroadcastResult txHash={broadcastedTxHash} network={multisig?.chain ?? ""} onReset={reset} />
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function DraftForm({
  recipients,
  setRecipients,
  feeRate,
  setFeeRate,
  label,
  setLabel,
  onBuild,
  busy,
  syncReady,
}: {
  recipients: RecipientRow[];
  setRecipients: (r: RecipientRow[]) => void;
  feeRate: string;
  setFeeRate: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  onBuild: () => void;
  busy: boolean;
  syncReady: boolean;
}) {
  return (
    <>
      <Section title="2. Recipients">
        <div className="space-y-2">
          {recipients.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2">
              <input
                type="text"
                value={r.address}
                onChange={(e) =>
                  setRecipients(recipients.map((row, idx) => (idx === i ? { ...row, address: e.target.value } : row)))
                }
                placeholder="ckb1… or ckt1…"
                spellCheck={false}
                className={`${inputCls} font-mono text-xs`}
              />
              <input
                type="text"
                value={r.amountCkb}
                onChange={(e) =>
                  setRecipients(recipients.map((row, idx) => (idx === i ? { ...row, amountCkb: e.target.value } : row)))
                }
                placeholder="amount CKB"
                inputMode="decimal"
                className={`${inputCls} tabular-nums`}
              />
              <button
                type="button"
                onClick={() => setRecipients(recipients.filter((_, idx) => idx !== i))}
                disabled={recipients.length === 1}
                className="rounded-md border border-surface-hi px-2 py-2 text-xs text-fg-muted hover:text-danger disabled:opacity-30"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRecipients([...recipients, { address: "", amountCkb: "" }])}
            className="text-xs text-fg-muted hover:text-fg"
          >
            + add recipient
          </button>
        </div>
      </Section>

      <Section title="3. Fee rate (shannons/byte)">
        <input
          type="text"
          value={feeRate}
          onChange={(e) => setFeeRate(e.target.value.replace(/\D/g, ""))}
          className={`${inputCls} tabular-nums`}
        />
      </Section>

      <Section title="4. Label (optional)">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. March payroll batch"
          className={inputCls}
        />
      </Section>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onBuild}
          disabled={busy || !syncReady}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!syncReady ? "waiting for sync…" : busy ? "fetching cells + building…" : "Build payment"}
        </button>
      </div>
    </>
  );
}

function PacketPanel({
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
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(packetJson)}
          className="rounded-md border border-surface-hi bg-surface px-3 py-1 text-xs hover:text-fg"
        >
          Copy packet
        </button>
      </div>
    </Section>
  );
}

function SignaturePanel({
  cfg,
  sigs,
  setSigs,
  onBroadcast,
  busy,
}: {
  cfg: CkbMultisigConfig;
  sigs: SignatureRow[];
  setSigs: (s: SignatureRow[]) => void;
  onBroadcast: () => void;
  busy: boolean;
}) {
  return (
    <Section title={`6. Collect signatures (${cfg.m} of ${cfg.n} needed)`}>
      <div className="space-y-3">
        {sigs.map((row, i) => (
          <div key={i} className="space-y-1">
            <label className="text-xs text-fg-muted">
              Signature {i + 1} — from co-signer
              <select
                value={row.slotIndex}
                onChange={(e) =>
                  setSigs(sigs.map((r, idx) => (idx === i ? { ...r, slotIndex: Number(e.target.value) } : r)))
                }
                className="ml-2 rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs"
              >
                {cfg.pubkeyHashes.map((h, idx) => (
                  <option key={idx} value={idx}>
                    {idx + 1}: {h.slice(0, 12)}…{h.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              value={row.signature}
              onChange={(e) =>
                setSigs(sigs.map((r, idx) => (idx === i ? { ...r, signature: e.target.value } : r)))
              }
              placeholder="0x… (130 hex chars)"
              rows={2}
              spellCheck={false}
              className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onBroadcast}
          disabled={busy || sigs.some((s) => !s.signature.trim())}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "broadcasting…" : "Merge & broadcast"}
        </button>
      </div>
    </Section>
  );
}

function BroadcastResult({
  txHash,
  network,
  onReset,
}: {
  txHash: string;
  network: string;
  onReset: () => void;
}) {
  const explorerUrl =
    network === "ckb:mainnet"
      ? `https://explorer.nervos.org/transaction/${txHash}`
      : `https://pudge.explorer.nervos.org/transaction/${txHash}`;
  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-5">
      <div className="text-sm font-medium text-accent">Broadcast successful</div>
      <div className="break-all font-mono text-xs text-fg">{txHash}</div>
      <div className="flex items-center gap-3 text-xs">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          View on explorer ↗
        </a>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-surface-hi bg-surface px-3 py-1 hover:text-fg"
        >
          Send another
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";

function lockFromAddress(addr: string): Script {
  if (!addr) throw new Error("Recipient address is empty");
  const { format, payload } = addressPayloadFromString(addr);
  if (format !== 0) {
    throw new Error(`unsupported address format ${format} (only Full / CKB2021 supported)`);
  }
  if (payload.length < 33) throw new Error(`address payload too short: ${payload.length} bytes`);
  const codeHash = hexFrom(new Uint8Array(payload.slice(0, 32)));
  const hashType = hashTypeFrom(payload[32]!);
  const args = hexFrom(new Uint8Array(payload.slice(33)));
  return Script.from({ codeHash, hashType, args });
}

function ckbToShannons(amountCkb: string): bigint | null {
  const trimmed = amountCkb.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = BigInt(wholeStr || "0");
  const fracPadded = (fracStr + "00000000").slice(0, 8);
  const frac = BigInt(fracPadded);
  const total = whole * SHANNONS_PER_CKB + frac;
  if (total <= 0n) return null;
  return total;
}

function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  const wholeFmt = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractional === 0n) return wholeFmt;
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${wholeFmt}.${fracStr}`;
}
