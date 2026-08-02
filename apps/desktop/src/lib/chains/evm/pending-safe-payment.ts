import {
  isMultisigTreasury,
  type EvmMultisig,
  type PendingTx,
  type Treasury,
} from "@chain-pay/shared";
import type { SafePaymentPayload } from "./safe";
import { serializeSafePayment } from "./safe";

export function pendingSafePayment(args: {
  id: string;
  treasury: Treasury;
  payload: SafePaymentPayload;
  signingDigest: `0x${string}`;
  accounting: NonNullable<PendingTx["accounting"]>;
  createdAt?: string;
}): PendingTx {
  if (!isMultisigTreasury(args.treasury) || !args.treasury.multisig.chain.startsWith("evm:")) {
    throw new Error("Safe payment requires an EVM treasury");
  }
  const multisig = args.treasury.multisig as EvmMultisig;
  if (
    multisig.chain !== `evm:${args.payload.chainId}` ||
    multisig.address.toLowerCase() !== args.payload.safeAddress.toLowerCase()
  ) {
    throw new Error("Safe payment payload does not belong to the selected treasury");
  }
  const createdAt = args.createdAt ?? new Date().toISOString();
  return {
    id: args.id,
    treasuryId: args.treasury.id,
    chain: multisig.chain,
    state: "awaiting_signature",
    signingDigest: args.signingDigest,
    outputs: [
      {
        to: args.payload.tx.to,
        amount: { asset: "ETH", value: args.payload.tx.value, decimals: 18 },
      },
    ],
    payloadJson: serializeSafePayment(args.payload),
    signatures: [],
    accounting: args.accounting,
    createdAt,
    updatedAt: createdAt,
  };
}
