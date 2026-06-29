// apps/desktop/src/lib/send/build-and-send.ts
import type { Cell, Script, ScriptInfo } from "@ckb-ccc/core";
import type { SendRecord, Source } from "@chain-pay/shared";
import type { CkbTxSigner } from "@/lib/signers/ckb-tx-signer";
import { buildSingleSigSend, type SingleSigRecipient } from "@/lib/chains/ckb/single-sig-tx-builder";
import { joyidLockAndDeps } from "@/lib/chains/ckb/joyid-lock";
import { secp256k1LockAndDeps } from "@/lib/chains/ckb/secp256k1-lock";
import { shannonsToCkbString } from "@/lib/send/ckb-amount";
import type { SignPreview } from "@/lib/signers/joyid-relay/types";

export interface SendDeps {
  listCellsForLock(lock: Script): Promise<Cell[]>;
  broadcast(tx: import("@ckb-ccc/core").Transaction): Promise<string>;
  resolveRecipientLock(address: string): Promise<Script>;
  /** JoyID (or default) lock script info. */
  scriptInfo: ScriptInfo;
  /**
   * secp256k1_blake160_sighash_all script info.
   * Required when source.lockKind === "secp256k1"; unused otherwise.
   */
  secp256k1ScriptInfo?: ScriptInfo;
  markSigning(id: string): void;
  markBroadcasted(id: string, hash: string): void;
  markBackToBuilt(id: string): void;
}

export async function buildAndSend(
  send: SendRecord,
  source: Source,
  signer: CkbTxSigner,
  feeRateShannonsPerByte: bigint,
  deps: SendDeps,
): Promise<{ txHash: string }> {
  const { lock: sourceLock, cellDeps } = (() => {
    if (source.lockKind === "secp256k1") {
      if (!deps.secp256k1ScriptInfo) {
        throw new Error(
          "secp256k1ScriptInfo is required in SendDeps when source.lockKind is 'secp256k1'",
        );
      }
      return secp256k1LockAndDeps(deps.secp256k1ScriptInfo, source.joyidLockArgs);
    }
    return joyidLockAndDeps(deps.scriptInfo, source.joyidLockArgs);
  })();
  const availableCells = await deps.listCellsForLock(sourceLock);

  const recipients: SingleSigRecipient[] = [];
  for (const o of send.outputs) {
    const lock = await deps.resolveRecipientLock(o.payeeAddress);
    recipients.push({ lock, capacity: o.amount.value });
  }

  const { tx, fee } = buildSingleSigSend({
    sourceLock,
    joyidCellDeps: cellDeps,
    recipients,
    availableCells,
    feeRateShannonsPerByte,
  });

  // Human-readable summary shown on the approver's phone before they sign.
  const preview: SignPreview = {
    to: send.outputs.map((o) => ({
      address: o.payeeAddress,
      ckb: shannonsToCkbString(o.amount.value),
    })),
    feeCkb: shannonsToCkbString(fee),
  };

  deps.markSigning(send.id);
  try {
    const signed = await signer.signTransaction(tx, preview);
    const txHash = await deps.broadcast(signed);
    deps.markBroadcasted(send.id, txHash);
    return { txHash };
  } catch (err) {
    deps.markBackToBuilt(send.id);
    throw err;
  }
}
