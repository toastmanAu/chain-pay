import { z } from "zod";

export const AuthResultSchema = z.object({
  address: z.string().min(1).max(256),
  pubkey: z.string().min(1).max(256),
  keyType: z.string().min(1).max(64),
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

export const SignResultSchema = z.object({
  signature: z.string().min(1).max(8192),
  message: z.string().min(1).max(16384),
  pubkey: z.string().min(1).max(256),
  keyType: z.string().min(1).max(64),
  // JoyID's WebAuthn algorithm id: ES256 (-7, native passkey) or RS256 (-257,
  // session key). Anything else is rejected so a malicious relay can't steer
  // verifySignature down an unexpected branch (review M1).
  alg: z.union([z.literal(-7), z.literal(-257)]),
  // The challenge the phone echoes back. Kept (not stripped) so the desktop can
  // run the @joyid/ckb signature/challenge verification before trusting the sig
  // (review H1). The locally-computed challenge remains authoritative.
  challenge: z.string().min(1).max(16384).optional(),
  attestation: z.string().max(16384).optional(),
});
export type SignResult = z.infer<typeof SignResultSchema>;

/** Narrow untrusted relay/phone-origin data. `decodeSearch` returns `{ data, error }`. */
export function parseDecoded<T>(schema: z.ZodType<T>, decoded: unknown): T {
  if (decoded && typeof decoded === "object" && "error" in decoded && (decoded as { error?: unknown }).error) {
    throw new Error(`JoyID returned error: ${String((decoded as { error: unknown }).error)}`);
  }
  const data =
    decoded && typeof decoded === "object" && "data" in decoded
      ? (decoded as { data: unknown }).data
      : decoded;
  return schema.parse(data);
}

export type SignPhase =
  | "idle"
  | "awaiting-scan"
  | "awaiting-confirm"
  | "assembling"
  | "done"
  | "error";

export interface SignPreview {
  to: { address: string; ckb: string }[];
  feeCkb: string;
}

export interface SignPresenter {
  showQr(url: string, kind: "connect" | "sign", preview?: SignPreview): void;
  updateStatus(phase: SignPhase): void;
  dismiss(): void;
}
