import { describe, it, expect, beforeEach } from "vitest";
import { useSyncQueue, _resetQueueForTests, backoffMs } from "./sync-queue";

const sample = {
  capturedAt: 1717286400000,
  imageRef: "img-1.jpg",
  extraction: { body: {}, field_confidences: {}, warnings: [] },
};

beforeEach(() => _resetQueueForTests());

describe("sync-queue", () => {
  it("enqueue adds a pending item", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    const items = useSyncQueue.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(id);
    expect(items[0]!.status).toBe("pending");
  });

  it("markSyncing then markSynced transitions correctly", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().markSyncing(id);
    expect(useSyncQueue.getState().findById(id)?.status).toBe("syncing");
    useSyncQueue.getState().markSynced(id, "inv_xyz");
    expect(useSyncQueue.getState().findById(id)?.status).toBe("synced");
    expect(useSyncQueue.getState().findById(id)?.syncedInvoiceId).toBe("inv_xyz");
  });

  it("markFailed bumps attempts and returns to pending", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().markFailed(id, "timeout");
    const item = useSyncQueue.getState().findById(id)!;
    expect(item.attempts).toBe(1);
    expect(item.status).toBe("pending");
    expect(item.lastError).toBe("timeout");
  });

  it("v1 stays 'pending' through repeated failures (no cellular escalation)", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    for (let i = 0; i < 10; i++) useSyncQueue.getState().markFailed(id, "5xx");
    expect(useSyncQueue.getState().findById(id)?.status).toBe("pending");
    expect(useSyncQueue.getState().findById(id)?.attempts).toBe(10);
  });

  it("backoffMs scales by attempts capped at 5min", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(4)).toBe(16000);
    expect(backoffMs(5)).toBe(32000);
    expect(backoffMs(8)).toBe(256000);
    expect(backoffMs(20)).toBe(300000);
  });

  it("nextDrainCandidate returns oldest pending", () => {
    const a = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().enqueue({ ...sample, capturedAt: 1717286400001 });
    expect(useSyncQueue.getState().nextDrainCandidate()?.id).toBe(a);
  });

  it("removeSynced returns image refs for items older than threshold", () => {
    const now = Date.now();
    const oldId = useSyncQueue.getState().enqueue({ ...sample, capturedAt: now - 48 * 3600 * 1000, imageRef: "old.jpg" });
    const recentId = useSyncQueue.getState().enqueue({ ...sample, capturedAt: now, imageRef: "recent.jpg" });
    useSyncQueue.getState().markSynced(oldId, "inv_old");
    useSyncQueue.getState().markSynced(recentId, "inv_recent");
    const purged = useSyncQueue.getState().removeSynced(24 * 3600 * 1000);
    expect(purged).toEqual(["old.jpg"]);
    expect(useSyncQueue.getState().findById(oldId)).toBeUndefined();
    expect(useSyncQueue.getState().findById(recentId)).toBeDefined();
  });

  it("applyEdits merges fields into extraction.body", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().applyEdits(id, { invoice_number: "EDITED-001", total: 99 });
    const item = useSyncQueue.getState().findById(id)!;
    expect(item.extraction.body.invoice_number).toBe("EDITED-001");
    expect(item.extraction.body.total).toBe(99);
  });
});
