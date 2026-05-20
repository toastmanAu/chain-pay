import { describe, expect, it } from "vitest";
import { decryptCkbCliKeystore } from "./ckb-cli-keystore";

// Canonical Ethereum Web3 Secret Storage Definition test vector.
// CKB-cli uses the same JSON schema (scrypt KDF, AES-128-CTR, keccak256 MAC).
// Source: https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition
const STANDARD_VECTOR_JSON = JSON.stringify({
  address: "008aeeda4d805471df9b2a5b0f38a0c3bcba786b",
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "83dbcc02d8ccb40e466191a123791e0e" },
    ciphertext: "d172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c",
    kdf: "scrypt",
    kdfparams: {
      dklen: 32,
      n: 262144,
      r: 1,
      p: 8,
      salt: "ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19",
    },
    mac: "2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097",
  },
  id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
  version: 3,
});
const STANDARD_PASSWORD = "testpassword";
const STANDARD_PRIVKEY = "7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d";

describe("decryptCkbCliKeystore", () => {
  it(
    "decrypts the standard Web3 keystore test vector (slow — scrypt N=262144)",
    async () => {
      const pk = await decryptCkbCliKeystore(STANDARD_VECTOR_JSON, STANDARD_PASSWORD);
      expect(bytesToHex(pk)).toBe(STANDARD_PRIVKEY);
      expect(pk.length).toBe(32);
    },
    60_000,
  );

  it("rejects the wrong password with a clear error", async () => {
    await expect(decryptCkbCliKeystore(STANDARD_VECTOR_JSON, "wrong-password")).rejects.toThrow(
      /MAC|password|incorrect/i,
    );
  }, 60_000);

  it("rejects unsupported keystore versions", async () => {
    const v1 = JSON.stringify({ ...JSON.parse(STANDARD_VECTOR_JSON), version: 1 });
    await expect(decryptCkbCliKeystore(v1, STANDARD_PASSWORD)).rejects.toThrow(/version/i);
  });

  it("rejects unsupported ciphers", async () => {
    const parsed = JSON.parse(STANDARD_VECTOR_JSON);
    parsed.crypto.cipher = "aes-256-gcm";
    await expect(decryptCkbCliKeystore(JSON.stringify(parsed), STANDARD_PASSWORD)).rejects.toThrow(
      /cipher/i,
    );
  });

  it("rejects unsupported KDFs", async () => {
    const parsed = JSON.parse(STANDARD_VECTOR_JSON);
    parsed.crypto.kdf = "pbkdf2";
    await expect(decryptCkbCliKeystore(JSON.stringify(parsed), STANDARD_PASSWORD)).rejects.toThrow(
      /kdf|scrypt/i,
    );
  });

  it("rejects malformed JSON", async () => {
    await expect(decryptCkbCliKeystore("not-json", STANDARD_PASSWORD)).rejects.toThrow();
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
