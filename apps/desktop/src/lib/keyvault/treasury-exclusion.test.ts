/**
 * Task E1 — Treasury exclusion guard tests.
 *
 * Proves three things:
 *   1. assertNotLocalKeystoreSigner throws the right error for kind:"local-keystore"
 *   2. assertNotLocalKeystoreSigner passes for legitimate single-sig signer kinds
 *   3. "local-keystore" is structurally absent from SignerKind — the treasury
 *      path's kind union — so TypeScript prevents the crossover at compile time
 *      even without the runtime guard.
 */
import { describe, it, expect } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import type { Hex20 } from "@shared/types";
import type { SignerKind } from "../signers/types";
import { assertNotLocalKeystoreSigner } from "./treasury-exclusion";
import { LocalKeystoreCkbTxSigner } from "../signers/local-keystore-ckb-tx-signer";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const LOCK_ARGS = ("0x" + "ab".repeat(20)) as Hex20;

/** A stub CkbTxSigner with kind:"local-keystore" (the forbidden kind). */
const localKeystoreStub = {
  kind: "local-keystore" as const,
  connect: async () => ({ address: "", lockArgs: LOCK_ARGS as string }),
  signTransaction: async (tx: Transaction) => tx,
};

/** A stub CkbTxSigner with kind:"joyid" (a legitimate single-sig kind). */
const joyidStub = {
  kind: "joyid" as const,
  connect: async () => ({ address: "ckt1test", lockArgs: LOCK_ARGS as string }),
  signTransaction: async (tx: Transaction) => tx,
};

// ---------------------------------------------------------------------------
// Guard behaviour
// ---------------------------------------------------------------------------

describe("assertNotLocalKeystoreSigner (treasury exclusion guard)", () => {
  it("rejects a kind:local-keystore stub with a clear error", () => {
    expect(() => assertNotLocalKeystoreSigner(localKeystoreStub)).toThrow(
      "local keystore signer is not permitted for treasury",
    );
  });

  it("accepts a kind:joyid stub without throwing", () => {
    expect(() => assertNotLocalKeystoreSigner(joyidStub)).not.toThrow();
  });

  it("rejects LocalKeystoreCkbTxSigner — the concrete production class", () => {
    const bridge = { signTx: async (_req: unknown) => ({ signedTx: "{}" }) };
    const signer = new LocalKeystoreCkbTxSigner({
      keyvaultId: "main",
      derivationIndex: 0,
      sourceLockArgs: LOCK_ARGS,
      password: "test-pw",
      bridge,
    });
    expect(() => assertNotLocalKeystoreSigner(signer)).toThrow(
      "local keystore signer is not permitted for treasury",
    );
  });

  it("error message explicitly names 'treasury or multisig signing'", () => {
    expect(() => assertNotLocalKeystoreSigner(localKeystoreStub)).toThrow(
      /treasury or multisig signing/,
    );
  });

  // -------------------------------------------------------------------------
  // Structural invariant — compile-time enforcement via @ts-expect-error
  //
  // The treasury/multisig path uses SignerTransport (lib/signers/types.ts).
  // SignerTransport.kind is typed as SignerKind:
  //
  //   SignerKind = "joyid" | "ledger-ckb" | "ckb-cli-keystore"
  //             | "metamask" | "walletconnect" | "ledger-evm"
  //
  // "local-keystore" is ABSENT from SignerKind, so TypeScript rejects any
  // attempt to assign "local-keystore" as a SignerKind. The @ts-expect-error
  // below suppresses that compile error. If someone ever accidentally adds
  // "local-keystore" to SignerKind, the suppression becomes an unused error
  // directive and `tsc --noEmit` fails — alerting the developer that the
  // treasury-exclusion invariant has been broken at the type level.
  // -------------------------------------------------------------------------

  it('structural invariant: "local-keystore" is not assignable to SignerKind', () => {
    // @ts-expect-error — "local-keystore" must not be in SignerKind; tsc fails if it is
    const _unused: SignerKind = "local-keystore";
    void _unused;
    // The real assertion is the compile-time @ts-expect-error above.
    // This runtime expect satisfies vitest's "at least one assertion" requirement.
    expect(true).toBe(true);
  });
});
