import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { SendRecord, SendState, TransactionHash } from "@chain-pay/shared";
import { assertCanTransition } from "@/lib/send/state-machine";

interface SendsStore {
  sends: SendRecord[];
  addSend: (s: SendRecord) => void;
  markBuilt: (id: string, feeShannons: bigint) => void;
  markSigning: (id: string) => void;
  markBroadcasted: (id: string, txHash: TransactionHash) => void;
  markBackToBuilt: (id: string) => void;
  markConfirmed: (id: string) => void;
  markPosting: (id: string) => void;
  markPosted: (id: string, jeName: string) => void;
  markPostFailed: (id: string, error: string) => void;
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}
function bigintReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

const sendsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function transition(
  sends: SendRecord[],
  id: string,
  to: SendState,
  patch: (s: SendRecord) => SendRecord,
): SendRecord[] {
  if (!sends.find((s) => s.id === id)) {
    throw new Error(`send not found: ${id}`);
  }
  return sends.map((s) => {
    if (s.id !== id) return s;
    assertCanTransition(s.state, to);
    return { ...patch(s), state: to, updatedAt: new Date().toISOString() };
  });
}

export const useSendsStore = create<SendsStore>()(
  persist(
    (set) => ({
      sends: [],
      addSend: (s) => set((st) => ({ sends: [...st.sends, s] })),
      markBuilt: (id, feeShannons) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => ({ ...s, feeShannons })) })),
      markSigning: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "signing", (s) => s) })),
      markBroadcasted: (id, txHash) =>
        set((st) => ({ sends: transition(st.sends, id, "broadcasted", (s) => ({ ...s, txHash })) })),
      markBackToBuilt: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => s) })),
      markConfirmed: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "confirmed", (s) => s) })),
      markPosting: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "posting", (s) => s) })),
      markPosted: (id, jeName) =>
        set((st) => ({
          sends: transition(st.sends, id, "posted", (s) => ({ ...s, journalEntryName: jeName, postError: undefined })),
        })),
      markPostFailed: (id, error) =>
        set((st) => ({
          sends: transition(st.sends, id, "post_failed", (s) => ({ ...s, postError: error })),
        })),
    }),
    {
      name: "chain-pay:sends",
      storage: createJSONStorage(() => sendsStorage, { replacer: bigintReplacer, reviver: bigintReviver }),
      version: 1,
      partialize: (st) => ({ sends: st.sends }),
    },
  ),
);
