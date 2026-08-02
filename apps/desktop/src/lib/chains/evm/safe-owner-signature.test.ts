import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { normalizeSafeOwnerSignature, verifySafeOwnerSignature } from "./safe-owner-signature";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const digest = `0x${"ab".repeat(32)}` as const;

describe("Safe owner signature verification", () => {
  it("recovers a canonical 65-byte signature", async () => {
    const signature = await account.sign({ hash: digest });
    await expect(verifySafeOwnerSignature({ digest, signer: account.address, signature })).resolves.toMatchObject({
      signer: account.address,
      bytes: expect.any(Uint8Array),
    });
  });

  it("normalizes recovery IDs 0/1 to Safe-compatible 27/28", async () => {
    const signature = await account.sign({ hash: digest });
    const zeroOrOne = `${signature.slice(0, -2)}${signature.endsWith("1b") ? "00" : "01"}` as Hex;
    expect(normalizeSafeOwnerSignature(zeroOrOne)).toBe(signature);
  });

  it("rejects malformed, unsupported, and wrong-owner signatures", async () => {
    expect(() => normalizeSafeOwnerSignature("0x12")).toThrow("65 bytes");
    expect(() => normalizeSafeOwnerSignature(`${"0x"}${"11".repeat(64)}02`)).toThrow("recovery ID");
    const signature = await account.sign({ hash: digest });
    await expect(
      verifySafeOwnerSignature({
        digest,
        signer: "0x2222222222222222222222222222222222222222",
        signature,
      }),
    ).rejects.toThrow("does not recover");
  });
});
