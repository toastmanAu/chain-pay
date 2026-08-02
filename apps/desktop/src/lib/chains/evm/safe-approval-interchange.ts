import { getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";
import type { EvmMultisig, PartialSignature, PendingTx } from "@chain-pay/shared";
import { assertSafeReviewBinding } from "./injected-owner-signer";
import { canonicalSafeTxHash, parseSafePayment } from "./safe";
import { bytesToHex, verifySafeOwnerSignature } from "./safe-owner-signature";

const approvalSchema = z
  .object({
    schema: z.literal("chainpay.safe-approval"),
    version: z.literal(1),
    chainId: z.literal(11155111),
    safeAddress: z.string().refine((value) => isAddress(value, { strict: false }), "invalid Safe address"),
    safeTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid SafeTx hash"),
    signer: z.string().refine((value) => isAddress(value, { strict: false }), "invalid signer address"),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "invalid 65-byte signature"),
  })
  .strict();

export type SafeApprovalEnvelope = z.infer<typeof approvalSchema>;

export async function serializeSafeApproval(args: {
  pending: PendingTx;
  multisig: EvmMultisig;
  signature: PartialSignature;
}): Promise<string> {
  const binding = approvalBinding(args.pending, args.multisig);
  const verified = await verifySafeOwnerSignature({
    digest: binding.safeTxHash,
    signer: args.signature.signerHash,
    signature: args.signature.bytes,
  });
  assertOwner(verified.signer, args.multisig);
  const envelope: SafeApprovalEnvelope = {
    schema: "chainpay.safe-approval",
    version: 1,
    chainId: 11155111,
    safeAddress: binding.safeAddress,
    safeTxHash: binding.safeTxHash,
    signer: verified.signer,
    signature: bytesToHex(verified.bytes),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function parseSafeApproval(args: {
  text: string;
  pending: PendingTx;
  multisig: EvmMultisig;
  signedAt?: number;
}): Promise<PartialSignature> {
  let raw: unknown;
  try {
    raw = JSON.parse(args.text);
  } catch {
    throw new Error("Safe approval file is not valid JSON");
  }
  const parsed = approvalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid Safe approval file: ${parsed.error.issues[0]?.message}`);
  }
  const envelope = parsed.data;
  const binding = approvalBinding(args.pending, args.multisig);
  if (envelope.chainId !== binding.chainId) throw new Error("Safe approval is for a different chain");
  if (envelope.safeAddress.toLowerCase() !== binding.safeAddress.toLowerCase()) {
    throw new Error("Safe approval is for a different Safe");
  }
  if (envelope.safeTxHash.toLowerCase() !== binding.safeTxHash.toLowerCase()) {
    throw new Error("Safe approval is for a different SafeTx");
  }
  assertOwner(envelope.signer, args.multisig);
  const verified = await verifySafeOwnerSignature({
    digest: binding.safeTxHash,
    signer: envelope.signer,
    signature: envelope.signature as Hex,
  });
  return { signerHash: verified.signer, bytes: verified.bytes, signedAt: args.signedAt ?? Date.now() };
}

function approvalBinding(pending: PendingTx, multisig: EvmMultisig) {
  const payload = parseSafePayment(pending.payloadJson);
  assertSafeReviewBinding(pending, multisig, payload);
  const safeTxHash = canonicalSafeTxHash(payload);
  if (safeTxHash.toLowerCase() !== pending.signingDigest.toLowerCase()) {
    throw new Error("Stored SafeTx hash does not match the reviewed transaction payload");
  }
  return {
    chainId: payload.chainId,
    safeAddress: getAddress(payload.safeAddress),
    safeTxHash,
  };
}

function assertOwner(signer: string, multisig: EvmMultisig): void {
  if (!multisig.owners.some((owner) => owner.toLowerCase() === signer.toLowerCase())) {
    throw new Error(`Safe approval signer ${signer} is not an owner of this Safe`);
  }
}
