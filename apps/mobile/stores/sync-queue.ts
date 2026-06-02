import { create } from "zustand";
import { ulid } from "ulid";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV();
const KEY = "chainpay.queue.v1";

// Note: "pending-cellular" reserved for v2 CEMP-PQ fallback; v1 never transitions into it.
export type QueueStatus = "pending" | "syncing" | "synced" | "rejected" | "pending-cellular";

export interface QueueItem {
  id: string;
  capturedAt: number;
  imageRef: string;
  extraction: { body: Record<string, unknown>; field_confidences: Record<string, number>; warnings: unknown[] };
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  syncedInvoiceId?: string;
  transport?: "ip" | "cemp-pq";
}

interface QueueState {
  items: QueueItem[];
  enqueue: (data: Omit<QueueItem, "id" | "status" | "attempts">) => string;
  markSyncing: (id: string) => void;
  markSynced: (id: string, invoiceId: string) => void;
  markFailed: (id: string, error: string) => void;
  markRejected: (id: string, error: string) => void;
  findById: (id: string) => QueueItem | undefined;
  nextDrainCandidate: () => QueueItem | undefined;
  removeSynced: (olderThanMs: number) => string[];
  applyEdits: (id: string, edits: Record<string, unknown>) => void;
}

function load(): QueueItem[] {
  const raw = storage.getString(KEY);
  return raw ? (JSON.parse(raw) as QueueItem[]) : [];
}

function save(items: QueueItem[]): void {
  storage.set(KEY, JSON.stringify(items));
}

export const useSyncQueue = create<QueueState>((set, get) => ({
  items: load(),

  enqueue: (data) => {
    const id = ulid();
    const item: QueueItem = { ...data, id, status: "pending", attempts: 0 };
    const items = [...get().items, item];
    save(items);
    set({ items });
    return id;
  },

  markSyncing: (id) => {
    const items = get().items.map((i) => (i.id === id ? { ...i, status: "syncing" as const } : i));
    save(items);
    set({ items });
  },

  markSynced: (id, invoiceId) => {
    const items = get().items.map((i) =>
      i.id === id ? { ...i, status: "synced" as const, syncedInvoiceId: invoiceId } : i,
    );
    save(items);
    set({ items });
  },

  markFailed: (id, error) => {
    const items = get().items.map((i) => {
      if (i.id !== id) return i;
      const attempts = i.attempts + 1;
      // v1: always retry as 'pending'; cellular escalation reserved for v2.
      return { ...i, status: "pending" as const, attempts, lastError: error };
    });
    save(items);
    set({ items });
  },

  markRejected: (id, error) => {
    const items = get().items.map((i) =>
      i.id === id ? { ...i, status: "rejected" as const, lastError: error } : i,
    );
    save(items);
    set({ items });
  },

  findById: (id) => get().items.find((i) => i.id === id),

  nextDrainCandidate: () =>
    get()
      .items.filter((i) => i.status === "pending" || i.status === "pending-cellular")
      .sort((a, b) => a.capturedAt - b.capturedAt)[0],

  removeSynced: (olderThanMs) => {
    const cutoff = Date.now() - olderThanMs;
    const toRemove = get().items.filter((i) => i.status === "synced" && i.capturedAt < cutoff);
    const items = get().items.filter((i) => !toRemove.includes(i));
    save(items);
    set({ items });
    return toRemove.map((i) => i.imageRef);
  },

  applyEdits: (id, edits) => {
    const items = get().items.map((i) =>
      i.id !== id ? i : {
        ...i,
        extraction: {
          ...i.extraction,
          body: { ...i.extraction.body, ...edits },
        },
      },
    );
    save(items);
    set({ items });
  },
}));

export function backoffMs(attempts: number): number {
  return Math.min(1000 * Math.pow(2, attempts), 300_000);
}

export function _resetQueueForTests(): void {
  storage.remove(KEY);
  useSyncQueue.setState({ items: [] });
}
