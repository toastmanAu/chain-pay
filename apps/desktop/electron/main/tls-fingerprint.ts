import { createHash } from "node:crypto";

/**
 * Compute SHA-256 fingerprint of a PEM-encoded certificate as
 * uppercase hex separated by colons (e.g. "AB:CD:EF:..."). The hash
 * is over the DER bytes (base64-decoded PEM body) — matches the
 * format used by openssl x509 -fingerprint -sha256.
 */
export function tlsFingerprint(certPem: string): string {
  const body = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  const der = Buffer.from(body, "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  const pairs = hex.match(/.{2}/g);
  if (!pairs) throw new Error("tlsFingerprint: empty digest");
  return pairs.join(":");
}
