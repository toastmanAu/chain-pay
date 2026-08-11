import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { addressPayloadFromString } from "@ckb-ccc/core/advanced";
import {
  bytesFrom,
  hexFrom,
  Script,
  Transaction,
  WitnessArgs,
} from "@ckb-ccc/core";
import { isMultisigTreasury, type CkbMultisig, type Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import {
  encodeMultisigScript,
  lockArgsFromConfig,
  type CkbMultisigConfig,
} from "@/lib/chains/ckb/multisig";
import { bytesEqual, bytesHex } from "@/lib/chains/ckb/bytes";
import { SHANNONS_PER_CKB, ckbToShannons } from "@/lib/chains/ckb/units";
import { lockFromAddress } from "@/lib/chains/ckb/address-lock";
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
import { CopyButton } from "@/components/clipboard/CopyButton";
import { PasteButton } from "@/components/clipboard/PasteButton";
import { AutoBroadcastCountdown } from "./AutoBroadcastCountdown";
import { PayeePicker } from "./PayeePicker";
import type {
  FxQuote,
  PartialSigEntry,
  PayeeProfile,
  PayrollBatch,
  PayrollBatchLine,
} from "@chain-pay/shared";
import { usePayeesStore } from "@/stores/payees";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useIncomingSigsStore } from "@/stores/incoming-sigs";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { CommSendSection } from "./CommSendSection";
import {
  fetchCkbPrices,
  fiatToCkbShannons,
  formatFxQuote,
} from "@/lib/fx/coingecko";
import { formatCkb } from "@/lib/format/ckb";
import { Section } from "@/components/ui/Section";

const DEFAULT_FEE_RATE = 1000n;

interface RecipientRow {
  address: string;
  amountCkb: string;
  /** Set when the row came from PayeePicker; lets FX recomputation re-fill amountCkb. */
  payeeId?: string;
  /** FX rate used to compute amountCkb, captured per-row so PayrollBatchLine has lineage. */
  fxRate?: string;
}

interface SignatureRow {
  slotIndex: number;
  signature: string;
}

type Phase = "draft" | "packet-ready" | "broadcast-ready" | "broadcasted";

export function PayPanel() {
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const ckbSync = useSyncStore((s) => s.ckb);
  const payeeStore = usePayeesStore();
  const batchStore = usePayrollBatchesStore();

  const ckbTreasuries = treasuries.filter(isMultisigTreasury).filter((t) => t.multisig.chain.startsWith("ckb:"));

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

  // FX snapshot, lifted from DraftForm so handleBuild can persist it on the
  // PayrollBatch record. fxSnapshot maps CURRENCY → FxQuote (CKB-based).
  const [fxSnapshot, setFxSnapshot] = useState<Map<string, FxQuote>>(new Map());
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);

  // Active batch id for this draft. Set when build succeeds with payee-sourced
  // rows; advances state on broadcast. null = manual one-off payment, no batch
  // lifecycle attached.
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  // Pre-select a batch and hydrate recipient rows from its lines if the
  // navigator passed `autoSelectBatchId` via state. Used by ReviewInvoiceForm
  // to land the operator on the batch they just queued. Only fires on mount.
  // Invoice-built batches have fiat amounts populated but crypto.value=0 — the
  // operator runs Fetch FX next to fill the amountCkb column.
  const location = useLocation();
  useEffect(() => {
    const state = location.state as { autoSelectBatchId?: string } | null;
    const batchId = state?.autoSelectBatchId;
    if (!batchId) return;
    setActiveBatchId(batchId);
    const batch = usePayrollBatchesStore.getState().findById(batchId);
    if (!batch || batch.kind !== "payroll" || batch.lines.length === 0) return;
    if (batch.treasuryId) setTreasuryId(batch.treasuryId);
    const payees = usePayeesStore.getState().payees;
    const hydrated: RecipientRow[] = batch.lines.map((line) => {
      const payee = payees.find((p) => p.id === line.payeeId);
      const row: RecipientRow = {
        address: payee?.walletAddress ?? "",
        amountCkb: line.crypto.value > 0n
          ? (Number(line.crypto.value) / Number(SHANNONS_PER_CKB)).toString()
          : "",
        payeeId: line.payeeId,
      };
      if (line.fxRate && line.fxRate !== "0") row.fxRate = line.fxRate;
      return row;
    });
    if (hydrated.length > 0) {
      setRecipients(hydrated);
      // Kick off FX fetch with the fresh rows so the operator doesn't have to
      // hunt for a "Fetch FX" button — by default that button only appears
      // after quotes load. Fires-and-forgets; refetchFx surfaces its own errors.
      void refetchFx(hydrated);
    }
    // mount-only — don't react to location changes mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const treasury = ckbTreasuries.find((t) => t.id === treasuryId);
  const multisig = treasury?.multisig as CkbMultisig | undefined;

  // 2.7b-2 drain-on-mount: if signatures arrived via comm while this PayPanel
  // wasn't observable, they're buffered in incoming-sigs. Drain into the
  // active batch when its sighashDigest becomes known.
  const activeBatch = activeBatchId
    ? batchStore.batches.find((b) => b.id === activeBatchId)
    : null;
  useEffect(() => {
    if (!activeBatch?.sighashDigest || !multisig) return;
    const buffered = useIncomingSigsStore.getState().peek(activeBatch.sighashDigest);
    if (buffered.length === 0) return;
    batchStore.drainIncomingSigsInto(activeBatch.id, {
      m: multisig.m,
      pubkeyHashes: multisig.pubkeyHashes,
    });
  }, [activeBatch?.id, activeBatch?.sighashDigest, multisig, batchStore]);
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

  // Hydrate from a persisted draft when the user clicks "Resume" on a
  // PayrollBatches card. Resume sets `selectedDraftId` in the store; we
  // read it once, switch to the right treasury if needed, then rebuild the
  // ephemeral PayPanel state (skeleton, packet, sigs) without recomputing
  // anything that could drift (FX, capacities, digest).
  useEffect(() => {
    const draftId = batchStore.selectedDraftId;
    if (!draftId) return;
    const batch = batchStore.findById(draftId);
    if (!batch || !batch.txBytes || !batch.sighashDigest || !batch.totals) {
      batchStore.selectDraft(null);
      return;
    }
    if (batch.treasuryId !== treasuryId) {
      // Switch treasuries first; the next render will materialize `cfg` and
      // re-enter this effect to actually hydrate.
      setTreasuryId(batch.treasuryId);
      return;
    }
    if (!cfg || !multisig) return;
    try {
      const tx = Transaction.fromBytes(bytesFrom(batch.txBytes));
      const restored: PaymentSkeleton = {
        tx,
        totalIn: batch.totals.totalIn,
        totalOut: batch.totals.totalOut,
        fee: batch.totals.fee,
        change: batch.totals.change,
      };
      const json = encodeTransferPacket({
        skeleton: restored,
        treasuryConfig: cfg,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        ...(batch.label ? { label: batch.label } : {}),
      });
      const restoredSigs: SignatureRow[] = Array.from(
        { length: cfg.m },
        (_, i) => {
          const found = batch.partialSigs?.find((p) => p.slotIndex === i);
          return { slotIndex: i, signature: found?.signature ?? "" };
        },
      );
      setSkeleton(restored);
      setPacketJson(json);
      setSigs(restoredSigs);
      setLabel(batch.label);
      setActiveBatchId(batch.id);
      setPhase("packet-ready");
      setError(null);
    } catch (e) {
      setError(`Failed to resume draft: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      batchStore.selectDraft(null);
    }
  }, [batchStore, treasuryId, cfg, multisig]);

  // Persist sig collection incrementally so closing the window mid-collection
  // doesn't lose work. Wrapped setter — same shape as setSigs for callers,
  // but writes through to the active batch's partialSigs on every change.
  const updateSigs = (next: SignatureRow[]) => {
    setSigs(next);
    if (activeBatchId) {
      const partials: PartialSigEntry[] = next
        .filter((s) => s.signature.trim().length > 0)
        .map((s) => ({ slotIndex: s.slotIndex, signature: s.signature.trim() }));
      batchStore.updateBatch(activeBatchId, { partialSigs: partials });
    }
  };

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

      // If the draft was sourced from payees, snapshot it as a PayrollBatch
      // in the 'calculated' state. Manual one-off payments (no payeeId on any
      // row) skip batch creation — they're not payroll, they're treasury
      // spends. The persisted snapshot carries the serialized tx + sighash
      // digest so PayPanel can resume from step 5/6 across navigation and
      // window reloads — critical because FX-rate drift on re-fetch would
      // otherwise change capacities → invalidate sigs already collected.
      const payeeLines = buildBatchLinesFromRecipients(
        recipients,
        payeeStore.findById,
      );
      if (payeeLines.length > 0) {
        const id = (globalThis.crypto?.randomUUID?.() ?? `b-${Date.now()}`) as string;
        const now = new Date().toISOString();
        const digest = treasurySighashDigest(result.tx);
        const batch: PayrollBatch = {
          id,
          kind: "payroll",
          label: label.trim() || autoLabel(),
          treasuryId,
          cycleStart: monthStart(),
          cycleEnd: monthEnd(),
          fxSnapshot: Array.from(fxSnapshot.values()),
          lines: payeeLines,
          state: "calculated",
          createdAt: now,
          updatedAt: now,
          txBytes: hexFrom(result.tx.toBytes()),
          sighashDigest: digest,
          totals: {
            totalIn: result.totalIn,
            totalOut: result.totalOut,
            fee: result.fee,
            change: result.change,
          },
          commPacket: json,
          partialSigs: [],
        };
        batchStore.addBatch(batch);
        setActiveBatchId(id);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Core merge-and-broadcast sequence shared by the manual button and the
   * auto-broadcast countdown.  Reconstructs the tx from `txBytes` (or falls
   * back to `skeleton.tx` when called from the manual path), merges the
   * provided partial signatures, runs pre-broadcast sanity checks, then
   * broadcasts through the light client.
   *
   * @param tx        - The unsigned transaction to sign and broadcast.
   * @param partials  - The M partial signatures to merge.
   * @returns The confirmed tx hash.
   */
  async function buildSignedTxAndBroadcast(
    tx: Transaction,
    partials: PartialSignature[],
  ): Promise<string> {
    if (!cfg) throw new Error("No multisig config available");

    const digest = treasurySighashDigest(tx);
    mergeSignatures(tx, cfg, digest, partials);

    // Pre-broadcast sanity: the multisig_script now sitting in witness[0]
    // MUST blake160 to the input cells' lock.args, or the chain returns -52
    // (ERROR_MULTSIG_SCRIPT_HASH). We check three things, in order of
    // diagnostic value:
    //
    //   1. cfg ↔ treasury.address: the stored treasury address must
    //      decode to lock.args matching what cfg.pubkeyHashes encode.
    //      If this fails, the wizard/persist layer mutated cfg without
    //      keeping address in sync.
    //   2. witness[0] ↔ cfg: the bytes mergeSignatures just wrote must
    //      blake160 to the same lock.args. If this fails, mergeSignatures
    //      or WitnessArgs round-trip is corrupting bytes.
    //   3. tx.inputs[0] ↔ treasury: caller's responsibility — the cells
    //      we're spending must be at the treasury's lock. Not checked
    //      inline (would need a chain query) but logged for inspection.
    if (multisig) {
      assertMultisigBytesMatchTreasury(tx, cfg, multisig);
      dumpInputsForInspection(tx, multisig);
    }

    return lightClient().broadcastTransaction(tx);
  }

  const handleBroadcast = async () => {
    if (!cfg || !skeleton) return;
    setError(null);
    setBusy(true);
    try {
      const partials: PartialSignature[] = sigs.map((s) => {
        if (!s.signature.trim()) throw new Error("All signature slots must be filled");
        return { slotIndex: s.slotIndex, signature: s.signature.trim() };
      });

      // Mark the batch approved just before send so a network failure leaves
      // us in a recoverable state (approved → calculated is a legal revert).
      if (activeBatchId) {
        try {
          batchStore.transition(activeBatchId, "approved");
        } catch {
          // ignore — batch may have been manually advanced or deleted
        }
      }
      const txHash = await buildSignedTxAndBroadcast(skeleton.tx, partials);
      setBroadcastedTxHash(txHash);
      setPhase("broadcasted");
      if (activeBatchId) {
        try {
          batchStore.transition(activeBatchId, "broadcasted");
          batchStore.updateBatch(activeBatchId, {
            pendingTxId: txHash,
            // Sigs are now embedded in the broadcast tx — no reason to keep
            // them around in the persisted batch.
            partialSigs: [],
          });
        } catch {
          // ignore — same recovery as above
        }
      }
    } catch (e: unknown) {
      const base = e instanceof Error ? e.message : String(e);
      // Append input outpoints to broadcast errors so the user can paste them
      // straight into an explorer without digging in DevTools — diagnoses -52
      // (input at wrong lock) and -51 (sig vs lock mismatch) by inspection.
      const inputs = skeleton?.tx.inputs ?? [];
      const inputSummary = inputs
        .map((inp, i) => `  [${i}] ${hexFrom(inp.previousOutput.txHash)} #${inp.previousOutput.index}`)
        .join("\n");
      const debug = inputs.length > 0 ? `\n\nTx inputs:\n${inputSummary}` : "";
      setError(`${base}${debug}`);
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
    setActiveBatchId(null);
    setFxSnapshot(new Map());
    setFxError(null);
  };

  function fillAmountsFromFx(
    rows: RecipientRow[],
    fx: Map<string, FxQuote>,
  ): RecipientRow[] {
    return rows.map((row) => {
      if (!row.payeeId) return row;
      const payee = payeeStore.findById(row.payeeId);
      if (!payee) return row;
      const quote = fx.get(payee.salaryFiat.currency.toUpperCase());
      if (!quote) return row;
      try {
        const shannons = fiatToCkbShannons(payee.salaryFiat, quote);
        const ckb = formatCkb(shannons);
        return { ...row, amountCkb: ckb, fxRate: quote.rate };
      } catch {
        return row;
      }
    });
  }

  async function loadPayees(payees: PayeeProfile[]) {
    const existing = recipients.filter((r) => r.address.trim() || r.amountCkb.trim());
    const additions = payees.map((p) => ({
      address: p.walletAddress,
      amountCkb: "",
      payeeId: p.id,
    }));
    let next = [...existing, ...additions];
    if (next.length === 0) next = [{ address: "", amountCkb: "" }];
    setRecipients(next);

    const currencies = Array.from(
      new Set(payees.map((p) => p.salaryFiat.currency.toUpperCase())),
    );
    if (currencies.length === 0) return;

    setFxLoading(true);
    setFxError(null);
    try {
      const fx = await fetchCkbPrices(currencies);
      const merged = new Map(fxSnapshot);
      for (const [k, v] of fx) merged.set(k, v);
      setFxSnapshot(merged);
      setRecipients(fillAmountsFromFx(next, merged));
    } catch (e) {
      setFxError(e instanceof Error ? e.message : String(e));
    } finally {
      setFxLoading(false);
    }
  }

  async function refetchFx(rowsOverride?: RecipientRow[]): Promise<void> {
    // Allow callers (e.g. mount-time hydration) to pass a fresh rows array so
    // currency detection isn't gated on the React state update having flushed.
    const rows = rowsOverride ?? recipients;
    const currencies = Array.from(
      new Set(
        rows
          .map((r) => (r.payeeId ? payeeStore.findById(r.payeeId)?.salaryFiat.currency : null))
          .filter((c): c is string => Boolean(c))
          .map((c) => c.toUpperCase()),
      ),
    );
    if (currencies.length === 0) return;
    setFxLoading(true);
    setFxError(null);
    try {
      const fx = await fetchCkbPrices(currencies);
      setFxSnapshot(fx);
      setRecipients(fillAmountsFromFx(rows, fx));
    } catch (e) {
      setFxError(e instanceof Error ? e.message : String(e));
    } finally {
      setFxLoading(false);
    }
  }

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

      {phase === "draft" && multisig ? (
        <DraftForm
          treasuryChain={multisig.chain}
          recipients={recipients}
          setRecipients={setRecipients}
          feeRate={feeRate}
          setFeeRate={setFeeRate}
          label={label}
          setLabel={setLabel}
          onBuild={handleBuild}
          busy={busy}
          syncReady={ckbSync.started && ckbSync.peers > 0}
          loadPayees={loadPayees}
          refetchFx={refetchFx}
          fxQuotes={Array.from(fxSnapshot.values())}
          fxLoading={fxLoading}
          fxError={fxError}
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
          setSigs={updateSigs}
          onBroadcast={handleBroadcast}
          busy={busy}
        />
      ) : null}

      {(phase === "packet-ready" || phase === "broadcast-ready") &&
      activeBatchId &&
      activeBatch?.sighashDigest &&
      multisig &&
      packetJson ? (
        <CommSendSection
          batchId={activeBatchId}
          packet={
            {
              txHash: activeBatch.sighashDigest,
              treasuryAddress: multisig.address,
              // Spec: 24 h advisory expiry; receiver enforcement is 2.7b-3.
              expiresAt: Math.floor(Date.now() / 1000) + 86_400,
              packet: packetJson as TransferPacket,
            } satisfies OutgoingPacket
          }
          multisig={{ pubkeyHashes: multisig.pubkeyHashes }}
        />
      ) : null}

      {/* Auto-broadcast toggle — visible when batch is approved (sigs being collected). */}
      {activeBatch && activeBatch.state === "approved" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={activeBatch.autoBroadcast === true}
            onChange={(e) => batchStore.setAutoBroadcast(activeBatch.id, e.target.checked)}
          />
          <span>Auto-broadcast when M sigs collected</span>
        </label>
      ) : null}

      {/* Auto-broadcast countdown — fires when store transitions to broadcast_countdown. */}
      {activeBatch && activeBatch.state === "broadcast_countdown" ? (
        <AutoBroadcastCountdown
          onElapsed={async () => {
            // Guard: a broadcast RPC URL must be configured (or light-client
            // broadcast must be viable). Check before marking initiating so
            // the user sees a clear error instead of a silent failure.
            const { broadcastRpcUrl } = useNetworkConfigStore.getState();
            if (!broadcastRpcUrl) {
              batchStore.markBroadcastFailed(
                activeBatch.id,
                "Configure broadcast RPC URL in Settings",
              );
              return;
            }
            // Reconstruct the tx from the persisted bytes so this path is
            // independent of React state (skeleton may be null if the user
            // navigated away and back).
            if (!activeBatch.txBytes) {
              batchStore.markBroadcastFailed(activeBatch.id, "No transaction bytes in batch");
              return;
            }
            if (!activeBatch.partialSigs || activeBatch.partialSigs.length === 0) {
              batchStore.markBroadcastFailed(activeBatch.id, "No partial signatures collected yet");
              return;
            }
            batchStore.markBroadcastInitiating(activeBatch.id);
            try {
              const tx = Transaction.fromBytes(bytesFrom(activeBatch.txBytes));
              const partials: PartialSignature[] = activeBatch.partialSigs.map((p) => ({
                slotIndex: p.slotIndex,
                signature: p.signature,
              }));
              // buildSignedTxAndBroadcast merges sigs into tx, runs sanity
              // checks, then broadcasts — same path as manual handleBroadcast.
              const txHash = await buildSignedTxAndBroadcast(tx, partials);
              setBroadcastedTxHash(txHash);
              setPhase("broadcasted");
              batchStore.transition(activeBatch.id, "broadcasted");
              batchStore.updateBatch(activeBatch.id, {
                pendingTxId: txHash,
                partialSigs: [],
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              batchStore.markBroadcastFailed(activeBatch.id, msg);
            }
          }}
          onCancel={() => batchStore.cancelAutoBroadcast(activeBatch.id)}
        />
      ) : null}

      {/* Retry button — visible when auto-broadcast failed. */}
      {activeBatch && activeBatch.state === "broadcast_failed" ? (
        <div className="rounded border border-red-800 bg-red-950/40 p-3 text-sm">
          <strong className="block">Broadcast failed</strong>
          <p className="text-xs text-neutral-400 mb-2">{activeBatch.broadcastError}</p>
          <button
            type="button"
            onClick={() => batchStore.retryAutoBroadcast(activeBatch.id)}
            className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm"
          >
            Retry broadcast
          </button>
        </div>
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
  treasuryChain,
  recipients,
  setRecipients,
  feeRate,
  setFeeRate,
  label,
  setLabel,
  onBuild,
  busy,
  syncReady,
  loadPayees,
  refetchFx,
  fxQuotes,
  fxLoading,
  fxError,
}: {
  treasuryChain: PayeeProfile["preferredChain"];
  recipients: RecipientRow[];
  setRecipients: (r: RecipientRow[]) => void;
  feeRate: string;
  setFeeRate: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  onBuild: () => void;
  busy: boolean;
  syncReady: boolean;
  loadPayees: (payees: PayeeProfile[]) => void | Promise<void>;
  refetchFx: () => void | Promise<void>;
  fxQuotes: FxQuote[];
  fxLoading: boolean;
  fxError: string | null;
}) {
  const fxAge = fxQuotes[0]?.takenAt
    ? new Date(fxQuotes[0].takenAt).toLocaleTimeString()
    : null;
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
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setRecipients([...recipients, { address: "", amountCkb: "" }])}
              className="text-xs text-fg-muted hover:text-fg"
            >
              + add recipient
            </button>
            <PayeePicker chainFilter={treasuryChain} onAdd={loadPayees} />
          </div>
          <FxSnapshotPanel
            quotes={fxQuotes}
            loading={fxLoading}
            error={fxError}
            takenAtLabel={fxAge}
            onRefresh={refetchFx}
          />
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
        <CopyButton value={packetJson} label="packet" title="Copy packet + stash in a bin" />
      </div>
    </Section>
  );
}

function FxSnapshotPanel({
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

/**
 * Pre-broadcast sanity: catch the -52 (ERROR_MULTSIG_SCRIPT_HASH) class of
 * failures before the tx leaves the renderer. Reports drift in plain bytes
 * so we can diagnose without round-tripping the chain.
 */
function assertMultisigBytesMatchTreasury(
  tx: Transaction,
  cfg: CkbMultisigConfig,
  multisig: CkbMultisig,
): void {
  const addrPayload = addressPayloadFromString(multisig.address);
  // CCC's addressPayloadFromString returns `format` separately and `payload` =
  // code_hash(32) | hash_type(1) | args(variable). Args therefore starts at
  // index 33 (NOT 34 — the format byte lives in `format`, not `payload`).
  const addrArgs = new Uint8Array(addrPayload.payload.slice(33));
  const fromCfg = lockArgsFromConfig(cfg);
  if (!bytesEqual(addrArgs, fromCfg)) {
    throw new Error(
      `Treasury config drift: blake160(multisig_script(cfg)) = 0x${bytesHex(fromCfg)}, ` +
        `but treasury.address decodes to lock.args 0x${bytesHex(addrArgs)}. ` +
        `cfg.pubkeyHashes order may have been mutated since wizard. ` +
        `Re-create the treasury from debug/keystores/setup.json.`,
    );
  }

  // Witness[0] consistency: the multisig_script we wrote must match what cfg encodes.
  const witnessBytes = bytesFrom(tx.witnesses[0] ?? "0x");
  const witnessArgs = WitnessArgs.fromBytes(witnessBytes);
  const lockBytes = witnessArgs.lock ? bytesFrom(witnessArgs.lock) : new Uint8Array(0);
  const scriptPrefixLen = 4 + 20 * cfg.n;
  if (lockBytes.length < scriptPrefixLen) {
    throw new Error(
      `witness[0].lock too short: ${lockBytes.length} bytes, need at least ${scriptPrefixLen}`,
    );
  }
  const expectedScript = encodeMultisigScript(cfg).multisigScript;
  if (!bytesEqual(lockBytes.slice(0, scriptPrefixLen), expectedScript)) {
    throw new Error(
      `witness[0] multisig_script doesn't match cfg.pubkeyHashes — mergeSignatures bug?`,
    );
  }
}

/**
 * Pre-broadcast diagnostic: surface the outpoints of every input so we can
 * look them up on an explorer when -52 fires. Doesn't throw — just enriches
 * the error path by dumping context onto window.__chainpay_debug.
 */
function dumpInputsForInspection(tx: Transaction, multisig: CkbMultisig): void {
  const summary = tx.inputs.map((inp, i) => ({
    slot: i,
    txHash: hexFrom(inp.previousOutput.txHash),
    index: Number(inp.previousOutput.index),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__chainpay_debug = {
    treasuryAddress: multisig.address,
    expectedLockArgs: "0x" + bytesHex(
      new Uint8Array(addressPayloadFromString(multisig.address).payload.slice(33, 53)),
    ),
    inputs: summary,
  };
  console.warn("[chainpay] tx inputs to broadcast", summary);
}

function buildBatchLinesFromRecipients(
  rows: RecipientRow[],
  findPayee: (id: string) => PayeeProfile | undefined,
): PayrollBatchLine[] {
  const lines: PayrollBatchLine[] = [];
  for (const row of rows) {
    if (!row.payeeId || !row.fxRate) continue;
    const payee = findPayee(row.payeeId);
    if (!payee) continue;
    const shannons = ckbToShannons(row.amountCkb);
    if (shannons === null) continue;
    lines.push({
      payeeId: row.payeeId,
      fiat: payee.salaryFiat,
      crypto: { asset: "CKB", value: shannons, decimals: 8 },
      fxRate: row.fxRate,
      // Per-line fee allocation is a polish concern; tx-level fee is on the
      // skeleton already. Start at 0; a follow-up can pro-rate the actual
      // skeleton.fee across lines.
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    });
  }
  return lines;
}

function autoLabel(): string {
  const d = new Date();
  return `Batch ${d.toISOString().slice(0, 10)}`;
}

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthEnd(): string {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
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
            <div className="flex items-center justify-between gap-2">
              <label className="flex flex-1 items-center gap-2 text-xs text-fg-muted">
                <span>Signature {i + 1} — from co-signer</span>
                <select
                  value={row.slotIndex}
                  onChange={(e) =>
                    setSigs(
                      sigs.map((r, idx) =>
                        idx === i ? { ...r, slotIndex: Number(e.target.value) } : r,
                      ),
                    )
                  }
                  className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs"
                >
                  {cfg.pubkeyHashes.map((h, idx) => (
                    <option key={idx} value={idx}>
                      {idx + 1}: {h.slice(0, 12)}…{h.slice(-6)}
                    </option>
                  ))}
                </select>
              </label>
              <PasteButton
                title={`Paste signature ${i + 1}`}
                onValue={(v) =>
                  setSigs(
                    sigs.map((r, idx) => (idx === i ? { ...r, signature: v.trim() } : r)),
                  )
                }
              />
            </div>
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

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";

