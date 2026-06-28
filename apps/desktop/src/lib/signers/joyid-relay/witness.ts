import { base64urlToHex } from "@joyid/common";
import { buildSignedTx } from "@joyid/ckb";
import type { SignResult } from "./types";

function stripHexPrefix(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

const HEX_RE = /^(0x)?[0-9a-f]*$/i;

function toHexMaybeBase64url(value: string): string {
  // Already hex? keep. Otherwise treat as base64url.
  return HEX_RE.test(value) ? stripHexPrefix(value) : stripHexPrefix(base64urlToHex(value));
}

/** DER ECDSA (30 LEN 02 rLen r 02 sLen s) → IEEE-P1363 r||s, 64 bytes / 128 hex. */
export function derToP1363(derHexInput: string): string {
  const der = stripHexPrefix(derHexInput);
  const bytes: number[] = [];
  for (let i = 0; i < der.length; i += 2) bytes.push(parseInt(der.slice(i, i + 2), 16));

  // Validate DER format early: must start with 0x30 (SEQUENCE) and have minimum structure
  if (bytes.length < 8 || bytes[0] !== 0x30 || bytes[2] !== 0x02) {
    throw new Error("Invalid DER signature");
  }

  // bytes[0]=0x30 seq, bytes[1]=total len, bytes[2]=0x02 int, bytes[3]=rLen
  const rLen = bytes[3] ?? 0;
  const rStart = 4;
  const rEnd = rStart + rLen;

  if (rEnd + 2 > bytes.length) {
    throw new Error("Invalid DER signature: truncated");
  }

  if (bytes[rEnd] !== 0x02) {
    throw new Error("Invalid DER signature: s component tag missing");
  }

  const sLen = bytes[rEnd + 1] ?? 0;
  const sStart = rEnd + 2;
  const sEnd = sStart + sLen;

  if (sEnd > bytes.length) {
    throw new Error("Invalid DER signature: truncated");
  }

  const toHex = (arr: number[]) => arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  let r = toHex(bytes.slice(rStart, rEnd));
  let s = toHex(bytes.slice(sStart, sEnd));
  r = r.length > 64 ? r.slice(-64) : r.padStart(64, "0");
  s = s.length > 64 ? s.slice(-64) : s.padStart(64, "0");
  return r + s;
}

export function normalizeSignResult(raw: SignResult): SignResult {
  const message = toHexMaybeBase64url(raw.message);
  const pubkey = stripHexPrefix(raw.pubkey);
  let signature = toHexMaybeBase64url(raw.signature);
  if (signature.length !== 128) signature = derToP1363(signature);
  return { ...raw, message, pubkey, signature };
}

export function assembleSignedCkbTx(
  unsignedCkbTx: unknown,
  raw: SignResult,
  witnessIndexes: number[],
): unknown {
  const normalized = normalizeSignResult(raw);
  // buildSignedTx expects the joyid CKBTransaction + SignMessageResponseData shape.
  return buildSignedTx(
    unsignedCkbTx as never,
    normalized as never,
    witnessIndexes,
  );
}
