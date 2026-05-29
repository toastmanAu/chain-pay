import { useCallback, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { TreasuryList } from "./features/treasury/TreasuryList";
import { SetupMultisig } from "./features/treasury/SetupMultisig";
import { TreasuryDetail } from "./features/treasury/TreasuryDetail";
import { PayrollBatches } from "./features/payroll/PayrollBatches";
import { PayPanel } from "./features/payments/PayPanel";
import { SignPanel } from "./features/sign/SignPanel";
import { Employees } from "./features/employees/Employees";
import { Settings } from "./features/settings/Settings";
import { useSyncStore } from "./stores/sync";
import { useNetworkConfigStore } from "./stores/network-config";
import { lightClient } from "./lib/light-client/client";
import { createCommTransport } from "./lib/comm";
import { useCommIdentityStore } from "./stores/comm-identity";
import { usePeerBookStore } from "./stores/peer-book";
import { useTreasuryStore } from "./stores/treasury";
import { useIncomingSigsStore } from "./stores/incoming-sigs";
import { useIncomingPacketsStore } from "./stores/incoming-packets";
import { usePayrollBatchesStore } from "./stores/payroll-batches";
import { useCommSendRetry } from "./features/payments/useCommSendRetry";
import { isExpired } from "./lib/comm/expires-at";
import type { OutgoingPacket } from "./lib/comm/types";
import type { TransferPacket } from "@chain-pay/shared";
import type { MultisigRouting } from "./features/payments/useCommSendDispatch";

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Boot effect: auto-starts the CommTransport when an identity with a published
 * profile exists, and wires the peer-book's refusal-invariant getter to live
 * treasury state. Re-evaluates on every comm-identity store change.
 */
function useCommTransportBoot(): void {
  useEffect(() => {
    // Wire peer-book's knownSignersGetter to live treasury state.
    usePeerBookStore.setState({
      knownSignersGetter: () => {
        const treasuries = useTreasuryStore.getState().treasuries;
        return treasuries.flatMap((t) =>
          "pubkeyHashes" in t.multisig
            ? t.multisig.pubkeyHashes.map((h) => ({
                treasuryId: t.id,
                pubkeyHash: hexToBytes(h),
              }))
            : [],
        );
      },
    });

    function maybeStart(): void {
      const transport = createCommTransport();
      const id = useCommIdentityStore.getState().identity;
      if (transport && id?.profileTxHash) {
        void transport.start();
      }
    }

    maybeStart();
    const unsub = useCommIdentityStore.subscribe(maybeStart);

    // Subscribe to incoming signatures (2.7b-2). Each envelope is enqueued
    // into incoming-sigs and — if a matching batch exists — immediately
    // drained into its partialSigs. The treasury lookup happens lazily inside
    // the handler so multisig config changes are picked up without re-binding.
    const transport = createCommTransport();
    const offSig = transport?.onIncomingSignature((senderHash, body) => {
      useIncomingSigsStore.getState().enqueue({
        sighashDigest: body.txHash,
        slotIndex: body.slotIndex,
        signature: body.signature,
        senderAddrHash: senderHash,
        receivedAt: Date.now(),
      });
      const batch = usePayrollBatchesStore
        .getState()
        .batches.find((b) => b.sighashDigest === body.txHash);
      if (!batch) return; // sits in buffer; PayPanel drain-on-mount will pick it up.
      const treasury = useTreasuryStore
        .getState()
        .treasuries.find((t) => t.id === batch.treasuryId);
      if (!treasury || !("pubkeyHashes" in treasury.multisig)) return;
      usePayrollBatchesStore.getState().drainIncomingSigsInto(batch.id, {
        m: treasury.multisig.m,
        pubkeyHashes: treasury.multisig.pubkeyHashes,
      });
    });

    // Packet receive — enqueue into incoming-packets (after watcher's expiresAt check).
    const offPacket = transport?.onIncomingPacket((senderHash, body) => {
      // Defensive: even though the watcher drops expired packets, double-check here.
      if (isExpired(body.expiresAt)) return;
      useIncomingPacketsStore.getState().enqueue({
        sighashDigest: body.txHash,
        packet: body,
        senderAddrHash: senderHash,
        receivedAt: Date.now(),
      });
    });

    // Ack receive — resolve sender → peer → slot, flip status to "acked".
    const offAck = transport?.onIncomingAck((senderHash, body) => {
      const peer = usePeerBookStore.getState().findByAddrHash(senderHash as `0x${string}`);
      if (!peer) return;
      const batch = usePayrollBatchesStore
        .getState()
        .batches.find((b) => b.sighashDigest === body.txHash);
      if (!batch) return;
      const treasury = useTreasuryStore
        .getState()
        .treasuries.find((t) => t.id === batch.treasuryId);
      if (!treasury || !("pubkeyHashes" in treasury.multisig)) return;
      if (peer.associatedSignerHash === undefined) return;
      const slotIndex = treasury.multisig.pubkeyHashes.indexOf(peer.associatedSignerHash);
      if (slotIndex < 0) return;
      usePayrollBatchesStore
        .getState()
        .recordCommSendStatus(batch.id, slotIndex, "acked");
    });

    return () => {
      unsub();
      offSig?.();
      offPacket?.();
      offAck?.();
      const transport = createCommTransport();
      void transport?.stop();
    };
  }, []);
}

export function App() {
  const startCkb = useSyncStore((s) => s.startCkb);
  const broadcastRpcUrl = useNetworkConfigStore((s) => s.broadcastRpcUrl);

  useEffect(() => {
    // Sync the persisted broadcast-RPC override to the LightClientHost on
    // every change. The host's setter is idempotent.
    lightClient().setBroadcastRpcUrl(broadcastRpcUrl);
  }, [broadcastRpcUrl]);

  useEffect(() => {
    // On boot: (1) check wipe flag in localStorage, (2) read network from store,
    // (3) call startCkb(network), (4) notify main process via electron.network.set.
    // The wipe flag sidesteps WASM IndexedDB Byte32 hash-mismatch panic when switching networks.
    void (async () => {
      const wipeFlag = globalThis.localStorage?.getItem(
        "chain-pay:wipe-lc-on-next-boot"
      );
      if (wipeFlag === "true") {
        try {
          await (
            globalThis as unknown as {
              chainpay: { lcStorage: { clear: () => Promise<void> } };
            }
          ).chainpay.lcStorage.clear();
          globalThis.localStorage?.removeItem("chain-pay:wipe-lc-on-next-boot");
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("lcStorage.clear failed:", err);
        }
      }
      const network = useNetworkConfigStore.getState().network;
      try {
        await (
          globalThis as unknown as {
            chainpay: { network: { set: (n: "testnet" | "mainnet") => Promise<void> } };
          }
        ).chainpay.network.set(network);
      } catch {
        /* preload may not be loaded in tests */
      }
      await startCkb(network);
    })();
  }, [startCkb]);

  useCommTransportBoot();

  // One-shot cleanup at app start: drop any expired incoming-packets entries
  // that survived from a previous session.
  useEffect(() => {
    useIncomingPacketsStore.getState().pruneExpired();
  }, []);

  // Resolvers MUST be memoized — useCommSendRetry's useEffect deps array includes them.
  const packetForBatch = useCallback((batchId: string): OutgoingPacket | null => {
    const batch = usePayrollBatchesStore.getState().findById(batchId);
    if (!batch || !batch.sighashDigest || !batch.commPacket) return null;
    const treasury = useTreasuryStore
      .getState()
      .treasuries.find((t) => t.id === batch.treasuryId);
    if (!treasury || !("pubkeyHashes" in treasury.multisig)) return null;
    const createdAtSec = Math.floor(new Date(batch.createdAt).getTime() / 1000);
    return {
      txHash: batch.sighashDigest,
      treasuryAddress: treasury.multisig.address,
      expiresAt: createdAtSec + 86_400,
      packet: batch.commPacket as TransferPacket,
    };
  }, []);

  const multisigForBatch = useCallback((batchId: string): MultisigRouting | null => {
    const batch = usePayrollBatchesStore.getState().findById(batchId);
    if (!batch) return null;
    const treasury = useTreasuryStore
      .getState()
      .treasuries.find((t) => t.id === batch.treasuryId);
    if (!treasury || !("pubkeyHashes" in treasury.multisig)) return null;
    return { pubkeyHashes: treasury.multisig.pubkeyHashes };
  }, []);

  useCommSendRetry({ packetForBatch, multisigForBatch });

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/treasury" element={<TreasuryList />} />
        <Route path="/treasury/new" element={<SetupMultisig />} />
        <Route path="/treasury/:id" element={<TreasuryDetail />} />
        <Route path="/payroll" element={<PayrollBatches />} />
        <Route path="/payments" element={<PayPanel />} />
        <Route path="/sign" element={<SignPanel />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
