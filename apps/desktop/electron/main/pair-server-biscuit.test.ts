import { describe, it, expect, beforeAll } from "vitest";
import {
  initBiscuit,
  generateRootKeypair,
  issueCaptureV1Token,
  verifyToken,
  extractTokenId,
} from "./pair-server-biscuit";

beforeAll(async () => {
  await initBiscuit();
});

describe("pair-server biscuit", () => {
  it("issues a token that verifies for write(invoices) action", async () => {
    const root = generateRootKeypair();
    const tok = issueCaptureV1Token({
      root,
      deviceLabel: "phone-1",
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    });
    const result = verifyToken({
      token: tok.token,
      rootPublicKey: root.publicKey,
      requiredCapability: 'write("invoices")',
      nowRfc3339: "2026-06-02T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.deviceLabel).toBe("phone-1");
  });

  it("rejects when the requested capability is not in the token", async () => {
    const root = generateRootKeypair();
    const tok = issueCaptureV1Token({
      root,
      deviceLabel: "phone-1",
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    });
    const result = verifyToken({
      token: tok.token,
      rootPublicKey: root.publicKey,
      requiredCapability: 'read("treasury")',
      nowRfc3339: "2026-06-02T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/capability/i);
  });

  it("rejects expired tokens", async () => {
    const root = generateRootKeypair();
    const tok = issueCaptureV1Token({
      root,
      deviceLabel: "phone-1",
      expiresAtRfc3339: "2020-01-01T00:00:00Z",
    });
    const result = verifyToken({
      token: tok.token,
      rootPublicKey: root.publicKey,
      requiredCapability: 'write("invoices")',
      nowRfc3339: "2026-06-02T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired|time/i);
  });

  it("extractTokenId returns the same id on re-parse", async () => {
    const root = generateRootKeypair();
    const tok = issueCaptureV1Token({
      root,
      deviceLabel: "phone-1",
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    });
    expect(extractTokenId(tok.token)).toBe(tok.tokenId);
  });

  it("verifies a token after hex round-trip (simulates desktop restart)", async () => {
    // Phase 1: issue token, capture pubkey hex
    const original = generateRootKeypair();
    const tok = issueCaptureV1Token({
      root: original,
      deviceLabel: "phone-restart",
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    });
    const storedPublicKeyHex = original.publicKey;

    // Phase 2: simulate restart — verify using ONLY the stored hex
    // (the original RootKeypair object is no longer in scope from the verifier's POV)
    const result = verifyToken({
      token: tok.token,
      rootPublicKey: storedPublicKeyHex,
      requiredCapability: 'write("invoices")',
      nowRfc3339: "2026-06-02T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.deviceLabel).toBe("phone-restart");
    expect(result.tokenId).toBe(tok.tokenId);
  });

  it("rejects malformed expiry at issue time", () => {
    const root = generateRootKeypair();
    expect(() =>
      issueCaptureV1Token({ root, deviceLabel: "x", expiresAtRfc3339: "not-a-date" }),
    ).toThrow(/RFC3339|valid|expiresAt/i);
  });
});
