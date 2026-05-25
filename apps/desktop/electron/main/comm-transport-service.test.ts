// Network-gated tests for the main-process comm transport service.
// generateIdentity requires a CCC client to derive an address; in 2.7b-1 we
// use ClientPublicTestnet which DOES NOT need a network round-trip for
// address derivation (script → bech32 is local). However the file is still
// gated behind ALLOW_NETWORK_TESTS for safety: anything that touches CCC
// internals may evolve to need RPC.
//
// Run with: ALLOW_NETWORK_TESTS=1 npx vitest run electron/main/comm-transport-service.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comm-transport-service-test-"));
const identityFile = path.join(tmpDir, "comm-identity.enc");

const { _setIdentityFileForTests } = await import("./comm-identity-store");
const { generateIdentity, exists, publicInfo, deleteIdentity } = await import(
  "./comm-transport-service"
);

const networkTest = process.env.ALLOW_NETWORK_TESTS ? it : it.skip;

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(identityFile, { force: true });
  _setIdentityFileForTests(identityFile);
});

describe("2.7c network awareness", () => {
  it("setCurrentNetwork('mainnet') makes mainnet publishProfile throw 'not deployed'", async () => {
    process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
    vi.resetModules();
    const mod = await import("./comm-transport-service");
    mod.setCurrentNetwork("mainnet");
    await expect(
      mod.publishProfile({ network: "mainnet", metadata: {} })
    ).rejects.toThrow(/CEMP-PQ contract not deployed on mainnet/);
  });

  it("publishProfile defaults to currentNetwork when args.network omitted", async () => {
    process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
    vi.resetModules();
    const mod = await import("./comm-transport-service");
    mod.setCurrentNetwork("mainnet");
    // Pass only metadata (no network key) — should inherit currentNetwork = "mainnet"
    await expect(
      mod.publishProfile({ metadata: {} })
    ).rejects.toThrow(/CEMP-PQ contract not deployed on mainnet/);
  });

  it("getCurrentNetwork reflects the last setCurrentNetwork call", async () => {
    vi.resetModules();
    const mod = await import("./comm-transport-service");
    mod.setCurrentNetwork("mainnet");
    expect(mod.getCurrentNetwork()).toBe("mainnet");
    mod.setCurrentNetwork("testnet");
    expect(mod.getCurrentNetwork()).toBe("testnet");
  });
});

describe("comm-transport-service", () => {
  networkTest(
    "generateIdentity returns addrHash as 0x-prefixed 20-byte hex",
    async () => {
      const id = await generateIdentity();
      expect(id.addrHash).toMatch(/^0x[0-9a-f]{40}$/);
    },
  );

  networkTest(
    "generateIdentity persists; publicInfo returns the same addrHash",
    async () => {
      const generated = await generateIdentity();
      const loaded = await publicInfo();
      expect(loaded?.addrHash).toBe(generated.addrHash);
    },
  );

  networkTest("generateIdentity refuses to overwrite existing identity", async () => {
    await generateIdentity();
    await expect(generateIdentity()).rejects.toThrow(/already exists/i);
  });

  networkTest(
    "deleteIdentity removes the file; exists returns false after",
    async () => {
      await generateIdentity();
      expect(await exists()).toBe(true);
      await deleteIdentity();
      expect(await exists()).toBe(false);
    },
  );
});
