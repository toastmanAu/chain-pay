import type { CommSendSlotStatus } from "@chain-pay/shared";
import { createCommTransport } from "@/lib/comm";
import type { OutgoingPacket, PeerProfile } from "@/lib/comm/types";
import { usePeerBookStore } from "@/stores/peer-book";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

export interface MultisigRouting {
  /** Canonical slot → signer pubkey hash. Slot index = array index. */
  pubkeyHashes: readonly `0x${string}`[];
}

export interface CommSendDispatchApi {
  /** Dispatch the packet to every slot in `multisig.pubkeyHashes` in order. */
  sendAll: (
    batchId: string,
    packet: OutgoingPacket,
    multisig: MultisigRouting,
  ) => Promise<void>;
  /** Re-dispatch one slot — used by the Retry button on error rows. */
  retry: (
    batchId: string,
    slotIndex: number,
    packet: OutgoingPacket,
    multisig: MultisigRouting,
  ) => Promise<void>;
  /** Live read of the per-slot status pill. Returns undefined if no send attempted. */
  statusFor: (batchId: string, slotIndex: number) => CommSendSlotStatus | undefined;
}

/**
 * Operator-side hook that routes an OutgoingPacket to each mapped peer, one
 * per multisig slot. Errors are isolated per slot — a failure on slot 2 does
 * not abort slot 3. All status writes go through
 * payroll-batches.recordCommSendStatus so the UI can subscribe via Zustand.
 *
 * The hook does NOT build the OutgoingPacket — the caller (PayPanel) provides
 * a pre-encoded packet so the same payload can be sent to every signer with
 * only per-recipient encryption differing.
 */
export function useCommSendDispatch(): CommSendDispatchApi {
  async function sendOne(
    batchId: string,
    slotIndex: number,
    packet: OutgoingPacket,
    multisig: MultisigRouting,
  ): Promise<void> {
    const record = usePayrollBatchesStore.getState().recordCommSendStatus;
    const expectedHash = multisig.pubkeyHashes[slotIndex];
    if (!expectedHash) {
      record(batchId, slotIndex, "error", { error: `no signer at slot ${slotIndex}` });
      return;
    }

    const peer = usePeerBookStore.getState().findByAssociatedSignerHash(expectedHash);
    if (!peer) {
      record(batchId, slotIndex, "error", {
        error: `no peer mapped to signer ${expectedHash}`,
      });
      return;
    }

    record(batchId, slotIndex, "sending");

    const transport = createCommTransport();
    if (!transport) {
      record(batchId, slotIndex, "error", { error: "comm channel not started" });
      return;
    }

    try {
      const profile: PeerProfile = peer.cachedProfile ?? (await transport.resolveProfile(peer.address));
      const txHash = await transport.sendPacket(profile, packet);
      record(batchId, slotIndex, "sent", { txHash });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      record(batchId, slotIndex, "error", { error });
    }
  }

  return {
    sendAll: async (batchId, packet, multisig) => {
      for (let slot = 0; slot < multisig.pubkeyHashes.length; slot++) {
        await sendOne(batchId, slot, packet, multisig);
      }
    },
    retry: async (batchId, slotIndex, packet, multisig) => {
      await sendOne(batchId, slotIndex, packet, multisig);
    },
    statusFor: (batchId, slotIndex) => {
      const batch = usePayrollBatchesStore.getState().findById(batchId);
      return batch?.commSendStatus?.[slotIndex];
    },
  };
}
