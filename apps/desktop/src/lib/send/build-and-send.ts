// apps/desktop/src/lib/send/build-and-send.ts
import type { Cell, Script, ScriptInfo } from "@ckb-ccc/core";
import type { SendRecord, Source } from "@chain-pay/shared";
import type { CkbTxSigner } from "@/lib/signers/ckb-tx-signer";
import { buildSingleSigSend, type SingleSigRecipient } from "@/lib/chains/ckb/single-sig-tx-builder";
import { joyidLockAndDeps } from "@/lib/chains/ckb/joyid-lock";

export interface SendDeps {
  listCellsForLock(lock: Script): Promise<Cell[]>;
  broadcast(tx: import("@ckb-ccc/core").Transaction): Promise<string>;
  resolveRecipientLock(address: string): Promise<Script>;
  scriptInfo: ScriptInfo;
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
  const { lock: sourceLock, cellDeps } = joyidLockAndDeps(deps.scriptInfo, source.joyidLockArgs);
  const availableCells = await deps.listCellsForLock(sourceLock);

  const recipients: SingleSigRecipient[] = [];
  for (const o of send.outputs) {
    const lock = await deps.resolveRecipientLock(o.payeeAddress);
    recipients.push({ lock, capacity: o.amount.value });
  }

  const { tx } = buildSingleSigSend({
    sourceLock,
    joyidCellDeps: cellDeps,
    recipients,
    availableCells,
    feeRateShannonsPerByte,
  });

  deps.markSigning(send.id);
  try {
    const signed = await signer.signTransaction(tx);
    const txHash = await deps.broadcast(signed);
    deps.markBroadcasted(send.id, txHash);
    return { txHash };
  } catch (err) {
    deps.markBackToBuilt(send.id);
    throw err;
  }
}
