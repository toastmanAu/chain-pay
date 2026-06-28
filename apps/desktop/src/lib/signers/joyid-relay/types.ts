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
  alg: z.number(),
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
