import { getAddress, isAddress, recoverAddress, type Address, type Hex } from "viem";

export interface VerifiedSafeOwnerSignature {
  signer: Address;
  data: Hex;
  bytes: Uint8Array;
}

/**
 * Normalize and recover a Safe EOA owner signature over an already-canonical
 * SafeTx hash. Only typed-data recovery IDs are accepted (0/1 or 27/28).
 */
export async function verifySafeOwnerSignature(args: {
  digest: string;
  signer: string;
  signature: Hex | Uint8Array;
}): Promise<VerifiedSafeOwnerSignature> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.digest)) throw new Error("SafeTx hash must be 32 bytes");
  if (!isAddress(args.signer, { strict: false })) throw new Error("Safe signer address is invalid");
  const signer = getAddress(args.signer);
  const data = normalizeSafeOwnerSignature(
    args.signature instanceof Uint8Array ? bytesToHex(args.signature) : args.signature,
  );
  const recovered = await recoverAddress({ hash: args.digest as Hex, signature: data });
  if (recovered.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`Safe signature does not recover to owner ${signer}`);
  }
  return { signer, data, bytes: hexToBytes(data) };
}

export function normalizeSafeOwnerSignature(signature: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("Safe owner signature must be exactly 65 bytes");
  }
  const recovery = signature.slice(-2).toLowerCase();
  if (recovery === "00") return `${signature.slice(0, -2)}1b` as Hex;
  if (recovery === "01") return `${signature.slice(0, -2)}1c` as Hex;
  if (recovery !== "1b" && recovery !== "1c") {
    throw new Error("Safe owner signature has an unsupported recovery ID");
  }
  return signature;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToBytes(hex: Hex): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}
