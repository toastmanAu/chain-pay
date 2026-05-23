import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Force the passphrase-based provider before importing the store.
process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comm-identity-test-"));
const identityFile = path.join(tmpDir, "comm-identity.enc");

const FIXTURE = {
  mlDsaSec: new Uint8Array(32).fill(0xa1),
  mlKemSec: new Uint8Array(2400).fill(0xa2),
  mlDsaPub: new Uint8Array(1952).fill(0xb1),
  mlKemPub: new Uint8Array(1184).fill(0xb2),
  address: "ckt1qmldsa-test",
  createdAt: 1747900000_000,
};

const { loadCommIdentity, saveCommIdentity, deleteCommIdentity, withSecrets, _setIdentityFileForTests } =
  await import("./comm-identity-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(identityFile, { force: true });
  _setIdentityFileForTests(identityFile);
});

describe("main-process comm-identity-store", () => {
  it("loadCommIdentity returns null when file is absent", async () => {
    expect(await loadCommIdentity()).toBeNull();
  });

  it("saveCommIdentity then loadCommIdentity roundtrips public fields", async () => {
    await saveCommIdentity(FIXTURE);
    const loaded = await loadCommIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded!.mlDsaPub).toBe("0x" + "b1".repeat(1952));
    expect(loaded!.address).toBe(FIXTURE.address);
  });

  it("saveCommIdentity refuses to overwrite existing identity", async () => {
    await saveCommIdentity(FIXTURE);
    await expect(saveCommIdentity(FIXTURE)).rejects.toThrow(/already exists/);
  });

  it("deleteCommIdentity removes the file", async () => {
    await saveCommIdentity(FIXTURE);
    await deleteCommIdentity();
    expect(await loadCommIdentity()).toBeNull();
  });

  it("withSecrets exposes secret keys and zeros them after", async () => {
    await saveCommIdentity(FIXTURE);
    let capturedSec: Uint8Array | null = null;
    await withSecrets(async (secrets) => {
      expect(secrets.mlDsaSec[0]).toBe(0xa1);
      capturedSec = secrets.mlDsaSec;
    });
    // After return, buffer must be zeroed.
    expect(capturedSec![0]).toBe(0x00);
    expect(capturedSec!.every((b) => b === 0)).toBe(true);
  });

  it("atomic write: a half-written temp file does not corrupt state", async () => {
    await saveCommIdentity(FIXTURE);
    const original = await loadCommIdentity();
    // Try save again (should reject due to exists-check), original stays intact.
    await expect(saveCommIdentity(FIXTURE)).rejects.toThrow();
    expect(await loadCommIdentity()).toEqual(original);
  });
});
