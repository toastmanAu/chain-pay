import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tls-cert-store-test-"));
const file = path.join(tmpDir, "tls-cert.enc");

const { _setTlsCertFileForTests, loadOrCreateTlsCert, rotateTlsCert, _resetTlsCertCacheForTests } =
  await import("./tls-cert-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(file, { force: true });
  _setTlsCertFileForTests(file);
  _resetTlsCertCacheForTests();
});

describe("tls-cert-store", () => {
  it("first call generates a new cert and persists it", async () => {
    const result = await loadOrCreateTlsCert();
    expect(result.key).toContain("BEGIN RSA PRIVATE KEY");
    expect(result.cert).toContain("BEGIN CERTIFICATE");
    expect(result.fingerprint).toMatch(/^[A-F0-9:]{95}$/);
    await fs.access(file); // file exists
  });

  it("second call returns the same persisted cert", async () => {
    const first = await loadOrCreateTlsCert();
    _resetTlsCertCacheForTests(); // force re-read from disk
    const second = await loadOrCreateTlsCert();
    expect(second.cert).toBe(first.cert);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("rotateTlsCert replaces the persisted cert with a new one", async () => {
    const first = await loadOrCreateTlsCert();
    const rotated = await rotateTlsCert();
    expect(rotated.cert).not.toBe(first.cert);
    expect(rotated.fingerprint).not.toBe(first.fingerprint);
    _resetTlsCertCacheForTests();
    const reread = await loadOrCreateTlsCert();
    expect(reread.cert).toBe(rotated.cert);
  });

  it("concurrent loadOrCreate calls share one cert generation", async () => {
    const [a, b] = await Promise.all([loadOrCreateTlsCert(), loadOrCreateTlsCert()]);
    expect(a.cert).toBe(b.cert);
  });

  it("rotateTlsCert serializes with an in-flight loadOrCreateTlsCert", async () => {
    // Kick off a load; immediately kick off a rotate. After both settle, cache should
    // be the rotated cert (the load's result is discarded).
    const loadP = loadOrCreateTlsCert();
    const rotateP = rotateTlsCert();
    const [loaded, rotated] = await Promise.all([loadP, rotateP]);
    expect(rotated.cert).not.toBe(loaded.cert);

    // Reset cache + re-read from disk; the on-disk cert must be the rotated one.
    _resetTlsCertCacheForTests();
    const reread = await loadOrCreateTlsCert();
    expect(reread.cert).toBe(rotated.cert);
  });
});
