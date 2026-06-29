import { describe, it, expect, vi } from "vitest";
import { Transaction, stringify } from "@ckb-ccc/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock electron so the module-level import of ipcMain doesn't fail outside Electron.
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

// Import the real WASM pkg (nodejs target, synchronous WASM init via readFileSync).
import * as wasm from "../../../../packages/ckb-keyvault-wasm/pkg/ckb_keyvault_wasm.js";
import { KeyvaultStore } from "./keyvault-store";
import { signTxInVault, importVault, unlockDeriveInVault } from "./keyvault-host";
import { KeyvaultRateLimiter } from "./keyvault-rate-limit";

// Standard BIP39 test mnemonic — deterministic derivation.
const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function freshStore(): KeyvaultStore {
  return new KeyvaultStore(mkdtempSync(join(tmpdir(), "kvh-")));
}

function minimalTx(): Transaction {
  return Transaction.from({
    inputs: [
      {
        previousOutput: {
          txHash: "0x" + "22".repeat(32),
          index: 0,
        },
      },
    ],
    outputs: [],
    outputsData: [],
  });
}

describe("keyvault-host security contract", () => {
  it("signs a tx whose source lock-args match the vault key", async () => {
    const store = freshStore();
    const { id, lockArgs } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );

    const tx = minimalTx();
    const res = await signTxInVault(
      {
        keyvaultId: id,
        password: "pw",
        derivationIndex: 0,
        unsignedTx: stringify(tx),
        sourceLockArgs: lockArgs,
        groupInputIndices: [0],
      },
      { store, wasm },
    );

    const signed = Transaction.from(JSON.parse(res.signedTx));
    // witnesses[0] must contain the 65-byte signature (not empty).
    expect(signed.witnesses[0]).not.toBe("0x");
    expect(signed.witnesses[0]).toBeDefined();
    // A WitnessArgs with a 65-byte lock serializes to more than 2 hex chars.
    expect((signed.witnesses[0]?.length ?? 0) > 10).toBe(true);
  });

  it("REFUSES to sign when source lock-args do not match the vault key (anti-blind-sign)", async () => {
    const store = freshStore();
    const { id } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );

    const tx = minimalTx();
    await expect(
      signTxInVault(
        {
          keyvaultId: id,
          password: "pw",
          derivationIndex: 0,
          unsignedTx: stringify(tx),
          // Wrong lock-args: all-0xff bytes — does not match the derived key.
          sourceLockArgs: "0x" + "ff".repeat(20),
          groupInputIndices: [0],
        },
        { store, wasm },
      ),
    ).rejects.toThrow(/lock args do not match/i);
  });

  it("rejects a wrong password", async () => {
    const store = freshStore();
    const { id, lockArgs } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );

    const tx = minimalTx();
    await expect(
      signTxInVault(
        {
          keyvaultId: id,
          password: "WRONG",
          derivationIndex: 0,
          unsignedTx: stringify(tx),
          sourceLockArgs: lockArgs,
          groupInputIndices: [0],
        },
        { store, wasm },
      ),
    ).rejects.toThrow(/wrong password/i);
  });

  it("locks out sign attempts after repeated wrong passwords (even with the correct one)", async () => {
    const store = freshStore();
    const { id, lockArgs } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );
    const limiter = new KeyvaultRateLimiter({
      maxAttempts: 3,
      baseDelayMs: 60_000,
      now: () => 1_000_000,
    });
    const tx = minimalTx();
    const badReq = {
      keyvaultId: id,
      password: "WRONG",
      derivationIndex: 0,
      unsignedTx: stringify(tx),
      sourceLockArgs: lockArgs,
      groupInputIndices: [0],
    };

    for (let i = 0; i < 3; i++) {
      await expect(
        signTxInVault(badReq, { store, wasm, limiter }),
      ).rejects.toThrow(/wrong password/i);
    }

    // 4th attempt — even with the CORRECT password — is refused by the limiter.
    await expect(
      signTxInVault({ ...badReq, password: "pw" }, { store, wasm, limiter }),
    ).rejects.toThrow(/too many/i);
  });

  it("resets the lockout counter after a successful sign", async () => {
    const store = freshStore();
    const { id, lockArgs } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );
    const limiter = new KeyvaultRateLimiter({
      maxAttempts: 3,
      baseDelayMs: 60_000,
      now: () => 1_000_000,
    });
    const tx = minimalTx();
    const base = {
      keyvaultId: id,
      derivationIndex: 0,
      unsignedTx: stringify(tx),
      sourceLockArgs: lockArgs,
      groupInputIndices: [0],
    };

    // 2 failures (below threshold of 3), then a success resets the counter.
    for (let i = 0; i < 2; i++) {
      await expect(
        signTxInVault({ ...base, password: "WRONG" }, { store, wasm, limiter }),
      ).rejects.toThrow(/wrong password/i);
    }
    await signTxInVault({ ...base, password: "pw" }, { store, wasm, limiter });

    // 2 more failures must NOT lock (counter was reset by the success).
    for (let i = 0; i < 2; i++) {
      await expect(
        signTxInVault({ ...base, password: "WRONG" }, { store, wasm, limiter }),
      ).rejects.toThrow(/wrong password/i);
    }
  });

  it("unlockDeriveInVault returns the derived lock-args and is rate-limited", async () => {
    const store = freshStore();
    const { id, lockArgs } = await importVault(
      { mnemonic: M, password: "pw" },
      { store, wasm },
    );
    const limiter = new KeyvaultRateLimiter({
      maxAttempts: 3,
      baseDelayMs: 60_000,
      now: () => 1_000_000,
    });

    // Correct password derives the same args importVault returned.
    const ok = await unlockDeriveInVault(
      { keyvaultId: id, password: "pw", derivationIndex: 0 },
      { store, wasm, limiter },
    );
    expect(ok.lockArgs.toLowerCase()).toBe(lockArgs.toLowerCase());

    // 3 wrong attempts then lockout (cheapest brute-force surface).
    for (let i = 0; i < 3; i++) {
      await expect(
        unlockDeriveInVault(
          { keyvaultId: id, password: "WRONG", derivationIndex: 0 },
          { store, wasm, limiter },
        ),
      ).rejects.toThrow(/wrong password/i);
    }
    await expect(
      unlockDeriveInVault(
        { keyvaultId: id, password: "pw", derivationIndex: 0 },
        { store, wasm, limiter },
      ),
    ).rejects.toThrow(/too many/i);
  });
});
