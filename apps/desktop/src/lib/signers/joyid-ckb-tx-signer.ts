import { Transaction } from "@ckb-ccc/core";
import type { CKBTransaction } from "@joyid/common";
import { initConfig, connect, signRawTransaction } from "@joyid/ckb";
import type { CkbTxSigner } from "./ckb-tx-signer";

/**
 * Real JoyID signer. initConfig sets the app name + redirect URL (must be
 * whitelisted in the JoyID app config and reachable from the Electron renderer).
 * INTEGRATION RISK: JoyID's popup/redirect inside Electron — see plan Task 7
 * note and design §3. Verify the @joyid/ckb API via Context7 before relying on
 * these signatures.
 */
export class JoyIdCkbTxSigner implements CkbTxSigner {
  readonly kind = "joyid" as const;
  private address = "";

  constructor(opts: { name: string; logo: string; joyidAppURL: string }) {
    initConfig({ name: opts.name, logo: opts.logo, joyidAppURL: opts.joyidAppURL });
  }

  async connect(): Promise<{ address: string; lockArgs: string }> {
    const res = await connect();
    this.address = res.address;
    // JoyID returns the address; lock args are derived from it by the orchestrator
    // via Address.fromString. Surface both for the Source record.
    return { address: res.address, lockArgs: res.pubkey ?? "0x" };
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    // CCC Transaction serialises to the same wire format as CKBTransaction
    // (witnesses[], outputs[], etc). Cast through unknown to satisfy the stricter
    // @joyid/common CKBTransaction shape — the fields are structurally identical
    // for the purposes of signing.
    const ckbTx = unsigned as unknown as CKBTransaction;
    const signed = await signRawTransaction(ckbTx, this.address);
    return Transaction.from(signed as unknown as Parameters<typeof Transaction.from>[0]);
  }
}
