import { describe, it, expect } from "vitest";
import { tlsFingerprint } from "./tls-fingerprint";

describe("tlsFingerprint", () => {
  it("produces uppercase hex with colon separators (95 chars for SHA-256)", () => {
    const pem = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIJAKaNVl2EsXSRMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yMDA1MTcwODI4MDhaFw0yMTA1MTcwODI4MDhaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDB80gn
HHCO9zMUFmZqejGZAEKKQqdmL7P+vYTLNRk1nB5sBpYIeMW0fJHwz3LiHa+3oirH
HOwANW8oafiW8qMrAgMBAAGjUDBOMB0GA1UdDgQWBBSjMyP3ifLuI9pTd+gZpfXX
ZmI4lzAfBgNVHSMEGDAWgBSjMyP3ifLuI9pTd+gZpfXXZmI4lzAMBgNVHRMEBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA0EAJWfeoTtCqgZeQUKy43BcyzC9hk6sZJ5+r6gG
8H+aXVeOzAqVGYbz6S2DcQqKZ9rGNeXyROCi09mE7+1qVPyR5w==
-----END CERTIFICATE-----`;
    const fp = tlsFingerprint(pem);
    expect(fp).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/);
    expect(fp.length).toBe(95);
  });

  it("is deterministic for the same input", () => {
    const pem = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIJAKaNVl2EsXSRMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yMDA1MTcwODI4MDhaFw0yMTA1MTcwODI4MDhaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDB80gn
HHCO9zMUFmZqejGZAEKKQqdmL7P+vYTLNRk1nB5sBpYIeMW0fJHwz3LiHa+3oirH
HOwANW8oafiW8qMrAgMBAAGjUDBOMB0GA1UdDgQWBBSjMyP3ifLuI9pTd+gZpfXX
ZmI4lzAfBgNVHSMEGDAWgBSjMyP3ifLuI9pTd+gZpfXXZmI4lzAMBgNVHRMEBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA0EAJWfeoTtCqgZeQUKy43BcyzC9hk6sZJ5+r6gG
8H+aXVeOzAqVGYbz6S2DcQqKZ9rGNeXyROCi09mE7+1qVPyR5w==
-----END CERTIFICATE-----`;
    expect(tlsFingerprint(pem)).toBe(tlsFingerprint(pem));
  });
});
