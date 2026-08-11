import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { CkbMultisig, Hex20 } from "@chain-pay/shared";
import {
  assertMultisigBytesMatchTreasury,
  dumpInputsForInspection,
} from "./multisig-assert";
import { encodeMultisigScript, type CkbMultisigConfig } from "./multisig";
import { deriveTreasuryAddress } from "./address";

const hash = (byte: string): Hex20 => ("0x" + byte.repeat(20)) as Hex20;

/**
 * A 2-of-3 config. The exact pubkey-hash bytes don't matter: every fixture
 * address is DERIVED from the config under test via the production
 * `deriveTreasuryAddress`, so the "matching" case is self-consistent by
 * construction rather than by a hand-written address literal.
 */
const CFG: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [hash("11"), hash("22"), hash("33")],
};

function multisigFor(cfg: CkbMultisigConfig): CkbMultisig {
  return {
    chain: "ckb:testnet",
    s: cfg.s,
    r: cfg.r,
    m: cfg.m,
    n: cfg.n,
    pubkeyHashes: cfg.pubkeyHashes,
    address: deriveTreasuryAddress(cfg, "testnet"),
  };
}

/** witness lock = multisig_script | M zeroed 65-byte signature slots. */
function placeholderLock(script: Uint8Array, m: number): Uint8Array {
  const lock = new Uint8Array(script.length + 65 * m);
  lock.set(script, 0);
  return lock;
}

function txWithWitnessLock(lock: Uint8Array): Transaction {
  const tx = Transaction.from({ inputs: [], outputs: [], outputsData: [] });
  tx.witnesses = [hexFrom(WitnessArgs.from({ lock: hexFrom(lock) }).toBytes())];
  return tx;
}

describe("assertMultisigBytesMatchTreasury", () => {
  it("passes when the witness script and the address both match the config", () => {
    const lock = placeholderLock(encodeMultisigScript(CFG).multisigScript, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).not.toThrow();
  });

  it("throws when the treasury address decodes to different lock args", () => {
    const otherCfg: CkbMultisigConfig = {
      ...CFG,
      pubkeyHashes: [hash("99"), hash("88"), hash("77")],
    };
    const lock = placeholderLock(encodeMultisigScript(CFG).multisigScript, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(otherCfg)),
    ).toThrow(/Treasury config drift/);
  });

  it("throws when witness[0].lock is shorter than the multisig script prefix", () => {
    expect(() =>
      assertMultisigBytesMatchTreasury(
        txWithWitnessLock(new Uint8Array(8)),
        CFG,
        multisigFor(CFG),
      ),
    ).toThrow(/witness\[0\]\.lock too short/);
  });

  it("throws when witness[0] carries a different multisig script", () => {
    // Same N (so same prefix length — the length guard must not fire first),
    // different pubkey hashes.
    const wrong = encodeMultisigScript({
      ...CFG,
      pubkeyHashes: [hash("aa"), hash("bb"), hash("cc")],
    }).multisigScript;
    const lock = placeholderLock(wrong, CFG.m);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).toThrow(/multisig_script doesn't match/);
  });
});

describe("dumpInputsForInspection", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__chainpay_debug;
  });

  it("publishes the debug global that manual smoke sessions read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const multisig = multisigFor(CFG);
    const tx = Transaction.from({
      inputs: [
        { previousOutput: { txHash: "0x" + "ab".repeat(32), index: 3 } },
        { previousOutput: { txHash: "0x" + "cd".repeat(32), index: 0 } },
      ],
      outputs: [],
      outputsData: [],
    });

    dumpInputsForInspection(tx, multisig);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const debug = (globalThis as any).__chainpay_debug;
    expect(debug).toBeDefined();
    expect(debug.treasuryAddress).toBe(multisig.address);
    expect(debug.expectedLockArgs).toMatch(/^0x[0-9a-f]{40}$/);
    expect(debug.inputs).toEqual([
      { slot: 0, txHash: "0x" + "ab".repeat(32), index: 3 },
      { slot: 1, txHash: "0x" + "cd".repeat(32), index: 0 },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
