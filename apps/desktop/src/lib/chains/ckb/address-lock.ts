import { addressPayloadFromString } from "@ckb-ccc/core/advanced";
import { hashTypeFrom, hexFrom, Script } from "@ckb-ccc/core";

export function lockFromAddress(addr: string): Script {
  if (!addr) throw new Error("Recipient address is empty");
  const { format, payload } = addressPayloadFromString(addr);
  if (format !== 0) {
    throw new Error(`unsupported address format ${format} (only Full / CKB2021 supported)`);
  }
  if (payload.length < 33) throw new Error(`address payload too short: ${payload.length} bytes`);
  const codeHash = hexFrom(new Uint8Array(payload.slice(0, 32)));
  const hashType = hashTypeFrom(payload[32]!);
  const args = hexFrom(new Uint8Array(payload.slice(33)));
  return Script.from({ codeHash, hashType, args });
}
