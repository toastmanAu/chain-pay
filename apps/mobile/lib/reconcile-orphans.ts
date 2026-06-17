import { File, Directory, Paths } from "expo-file-system";
import { useSyncQueue } from "@/stores/sync-queue";

export const ORPHAN_MIN_AGE_MS = 5 * 60_000;
const CAPTURE_RE = /^capture-.*\.jpg$/;

/**
 * Deletes capture images in the cache that no queue item references AND whose
 * mtime is older than ORPHAN_MIN_AGE_MS (so a just-captured, not-yet-enqueued
 * file is never removed). Best-effort: any per-file/list error is swallowed.
 * Returns the names of deleted files. `now` is injectable for tests.
 */
export function reconcileOrphanImages(now: number = Date.now()): string[] {
  const referenced = new Set(useSyncQueue.getState().items.map((i) => i.imageRef));
  const deleted: string[] = [];

  let entries: (File | Directory)[];
  try {
    entries = new Directory(Paths.cache).list();
  } catch {
    return deleted;
  }

  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    const name = entry.name;
    if (!CAPTURE_RE.test(name)) continue;
    if (referenced.has(name)) continue;

    let mtime: number | undefined;
    try {
      mtime = entry.info().modificationTime ?? undefined;
    } catch {
      continue;
    }
    if (typeof mtime !== "number") continue; // unknown age → keep
    if (now - mtime <= ORPHAN_MIN_AGE_MS) continue; // too fresh → keep

    try {
      entry.delete();
      deleted.push(name);
    } catch {
      // best-effort
    }
  }

  return deleted;
}
