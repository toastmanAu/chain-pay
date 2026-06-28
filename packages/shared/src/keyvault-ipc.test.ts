import { describe, it, expect } from "vitest";
import { SignTxRequest, KEYVAULT_CHANNELS } from "./keyvault-ipc";

describe("SignTxRequest schema", () => {
  it("rejects a sign request with a non-hex-40 lock args", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 0,
      unsignedTx: "{}",
      sourceLockArgs: "0xzz",
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });

  it("accepts a well-formed sign request", () => {
    const ok = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 0,
      unsignedTx: "{}",
      sourceLockArgs: "0x" + "ab".repeat(20),
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(ok).success).toBe(true);
  });

  it("rejects derivationIndex below 0", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: -1,
      unsignedTx: "{}",
      sourceLockArgs: "0x" + "ab".repeat(20),
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });

  it("rejects derivationIndex above 2_147_483_647", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 2_147_483_648,
      unsignedTx: "{}",
      sourceLockArgs: "0x" + "ab".repeat(20),
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });

  it("rejects empty groupInputIndices", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 0,
      unsignedTx: "{}",
      sourceLockArgs: "0x" + "ab".repeat(20),
      groupInputIndices: [],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });

  it("rejects sourceLockArgs missing 0x prefix", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 0,
      unsignedTx: "{}",
      sourceLockArgs: "ab".repeat(20),
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });

  it("rejects sourceLockArgs with wrong byte length (21 bytes)", () => {
    const bad = {
      keyvaultId: "k1",
      password: "p",
      derivationIndex: 0,
      unsignedTx: "{}",
      sourceLockArgs: "0x" + "ab".repeat(21),
      groupInputIndices: [0],
    };
    expect(SignTxRequest.safeParse(bad).success).toBe(false);
  });
});

describe("KEYVAULT_CHANNELS", () => {
  it("has correct signTx channel name", () => {
    expect(KEYVAULT_CHANNELS.signTx).toBe("keyvault:sign-tx");
  });

  it("has correct unlockDerive channel name", () => {
    expect(KEYVAULT_CHANNELS.unlockDerive).toBe("keyvault:unlock-derive");
  });

  it("has all eight channels", () => {
    const keys = Object.keys(KEYVAULT_CHANNELS);
    expect(keys).toHaveLength(8);
  });

  it("channel object is frozen", () => {
    expect(Object.isFrozen(KEYVAULT_CHANNELS)).toBe(true);
  });
});
