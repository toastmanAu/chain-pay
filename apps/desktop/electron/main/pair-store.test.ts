import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pair-store-test-"));
const file = path.join(tmpDir, "paired-devices.enc");

const {
  _setPairStoreFileForTests,
  listDevices,
  addDevice,
  revokeDevice,
  isRevoked,
  getDeviceByTokenId,
} = await import("./pair-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(file, { force: true });
  _setPairStoreFileForTests(file);
});

describe("pair-store", () => {
  it("returns empty list initially", async () => {
    expect(await listDevices()).toEqual([]);
  });

  it("persists an added device across reads", async () => {
    await addDevice({
      tokenId: "tok-abc",
      deviceLabel: "phill-pixel-8",
      commPubkey: "0x" + "11".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: 1717286400000,
      expiresAt: 1719878400000,
    });
    const list = await listDevices();
    expect(list).toHaveLength(1);
    expect(list[0]!.deviceLabel).toBe("phill-pixel-8");
  });

  it("revokes a device and reports it via isRevoked", async () => {
    await addDevice({
      tokenId: "tok-revoke",
      deviceLabel: "x",
      commPubkey: "0x" + "22".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: 0,
      expiresAt: 1,
    });
    expect(await isRevoked("tok-revoke")).toBe(false);
    await revokeDevice("tok-revoke");
    expect(await isRevoked("tok-revoke")).toBe(true);
  });

  it("getDeviceByTokenId returns the matching device", async () => {
    await addDevice({
      tokenId: "tok-find",
      deviceLabel: "find-me",
      commPubkey: "0x" + "33".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: 0,
      expiresAt: 1,
    });
    const got = await getDeviceByTokenId("tok-find");
    expect(got?.deviceLabel).toBe("find-me");
  });

  it("addDevice with duplicate tokenId replaces the existing entry", async () => {
    await addDevice({
      tokenId: "tok-dup", deviceLabel: "first-name", commPubkey: "0x" + "44".repeat(32),
      capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 1,
    });
    await addDevice({
      tokenId: "tok-dup", deviceLabel: "second-name", commPubkey: "0x" + "55".repeat(32),
      capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 1,
    });
    const list = await listDevices();
    expect(list).toHaveLength(1);
    expect(list[0]!.deviceLabel).toBe("second-name");
    expect(list[0]!.commPubkey).toBe("0x" + "55".repeat(32));
  });

  it("revokeDevice with unknown tokenId is a silent no-op", async () => {
    await expect(revokeDevice("nonexistent-token")).resolves.toBeUndefined();
    expect(await listDevices()).toEqual([]);
  });
});
