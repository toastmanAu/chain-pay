import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockState, queueState } = vi.hoisted(() => ({
  mockState: { entries: [] as unknown[] },
  queueState: { items: [] as { imageRef: string }[] },
}));

vi.mock("expo-file-system", () => {
  class File {
    name: string;
    _mtime: number | undefined;
    deleted = false;
    constructor(name = "", mtime?: number) {
      this.name = name;
      this._mtime = mtime;
    }
    info(): { exists: boolean; modificationTime: number | undefined } {
      return { exists: true, modificationTime: this._mtime };
    }
    delete(): void {
      this.deleted = true;
    }
  }
  class Directory {
    constructor(_p?: unknown) {}
    list(): unknown[] {
      return mockState.entries;
    }
  }
  return { File, Directory, Paths: { cache: "/cache" } };
});

vi.mock("@/stores/sync-queue", () => ({
  useSyncQueue: { getState: () => ({ items: queueState.items }) },
}));

import { File, Directory } from "expo-file-system";
import { reconcileOrphanImages, ORPHAN_MIN_AGE_MS } from "./reconcile-orphans";

const NOW = 1_700_000_000_000;
const makeEntry = (name: string, mtime?: number): InstanceType<typeof File> =>
  new (File as unknown as new (n: string, m?: number) => InstanceType<typeof File>)(name, mtime);

beforeEach(() => {
  mockState.entries = [];
  queueState.items = [];
});

describe("reconcileOrphanImages", () => {
  it("deletes unreferenced capture-*.jpg older than the threshold", () => {
    const old = makeEntry("capture-1.jpg", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [old];
    expect(reconcileOrphanImages(NOW)).toEqual(["capture-1.jpg"]);
    expect((old as unknown as { deleted: boolean }).deleted).toBe(true);
  });

  it("keeps a fresh unreferenced capture (race guard)", () => {
    const fresh = makeEntry("capture-2.jpg", NOW - 1000);
    mockState.entries = [fresh];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((fresh as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("keeps a referenced capture regardless of age", () => {
    const ref = makeEntry("capture-3.jpg", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [ref];
    queueState.items = [{ imageRef: "capture-3.jpg" }];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((ref as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("keeps a capture with unknown modificationTime", () => {
    const noMtime = makeEntry("capture-4.jpg", undefined);
    mockState.entries = [noMtime];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((noMtime as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("ignores non-capture files", () => {
    const other = makeEntry("notes.txt", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [other];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((other as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("skips Directory entries (only processes File instances)", () => {
    const dir = new (Directory as unknown as new () => InstanceType<typeof Directory>)();
    mockState.entries = [dir];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
  });
});
