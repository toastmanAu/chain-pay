import { describe, expect, it } from "vitest";
import { lockFromAddress } from "./address-lock";

// A CKB2021 full-format testnet address (secp256k1_blake160_sighash_all).
// Real address: signer1's single-sig address from debug/keystores/setup.json
// (also used in apps/desktop/src/stores/payees.test.ts). The brief's
// hand-constructed fixture failed to decode ("Unknown address format" —
// invalid bech32m checksum), so this verified address replaces it.
const TESTNET_ADDRESS =
  "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2yl2dtdldv6jp87hkpd8p3a8n77346jzq2wz6r9";

describe("lockFromAddress", () => {
  it("decodes code hash, hash type, and args from a full address", () => {
    const script = lockFromAddress(TESTNET_ADDRESS);
    expect(script.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(script.args).toMatch(/^0x[0-9a-f]+$/);
  });

  it("throws on an empty address", () => {
    expect(() => lockFromAddress("")).toThrow("Recipient address is empty");
  });

  it("throws on a malformed address", () => {
    expect(() => lockFromAddress("not-an-address")).toThrow();
  });
});
