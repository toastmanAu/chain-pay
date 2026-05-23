import { EnvelopeMalformedError } from "./errors";
import type { CommEnvelopeKind } from "./types";
import { ENVELOPE_VERSION } from "./types";

export const ENVELOPE_HEADER_LEN = 22; // 1 (version) + 1 (kind) + 20 (sender_addr_hash)

const KIND_BYTE: Record<CommEnvelopeKind, number> = {
  packet: 0x01,
  signature: 0x02,
  ack: 0x03,
};

const BYTE_TO_KIND: Record<number, CommEnvelopeKind> = {
  0x01: "packet",
  0x02: "signature",
  0x03: "ack",
};

export interface EncodeArgs<T = unknown> {
  kind: CommEnvelopeKind;
  senderAddrHash: Uint8Array;
  payload: T;
}

export interface DecodedEnvelope<T = unknown> {
  version: number;
  kind: CommEnvelopeKind;
  senderAddrHash: Uint8Array;
  payload: T;
}

export function encodeEnvelope<T>(args: EncodeArgs<T>): Uint8Array {
  if (args.senderAddrHash.length !== 20) {
    throw new Error(
      `sender_addr_hash must be exactly 20 bytes, got ${args.senderAddrHash.length}`,
    );
  }
  const json = new TextEncoder().encode(JSON.stringify(args.payload));
  const out = new Uint8Array(ENVELOPE_HEADER_LEN + json.length);
  out[0] = ENVELOPE_VERSION;
  out[1] = KIND_BYTE[args.kind];
  out.set(args.senderAddrHash, 2);
  out.set(json, ENVELOPE_HEADER_LEN);
  return out;
}

export function decodeEnvelope<T = unknown>(bytes: Uint8Array): DecodedEnvelope<T> {
  if (bytes.length < ENVELOPE_HEADER_LEN) {
    throw new EnvelopeMalformedError(
      `envelope too short: ${bytes.length} < ${ENVELOPE_HEADER_LEN}`,
    );
  }

  const version = bytes[0];
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeMalformedError(`unsupported envelope version ${version}`);
  }

  const kindByte = bytes[1];
  const kind = BYTE_TO_KIND[kindByte];
  if (!kind) {
    throw new EnvelopeMalformedError(`unknown envelope kind byte 0x${kindByte.toString(16)}`);
  }

  const senderAddrHash = bytes.slice(2, ENVELOPE_HEADER_LEN);

  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes.slice(ENVELOPE_HEADER_LEN))) as T;
  } catch (cause) {
    throw new EnvelopeMalformedError("envelope payload is not valid JSON", { cause });
  }

  return { version, kind, senderAddrHash, payload };
}
