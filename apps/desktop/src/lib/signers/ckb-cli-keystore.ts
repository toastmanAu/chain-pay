import { ctr } from "@noble/ciphers/aes";
import { keccak_256 } from "@noble/hashes/sha3";
import { scryptAsync } from "@noble/hashes/scrypt";

/**
 * Decrypt a CKB-cli (or Ethereum web3) v3 keystore JSON to its 32-byte
 * private key.
 *
 * Format spec: https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition
 *
 *   derivedKey = scrypt(password, salt, N, r, p, dklen=32)
 *   encryption_key = derivedKey[0..16]
 *   mac_key        = derivedKey[16..32]
 *   privateKey     = aes_128_ctr_decrypt(encryption_key, iv, ciphertext)
 *   computed_mac   = keccak256(mac_key || ciphertext)   — must match `mac`
 *
 * The MAC check is the password-correctness signal — a wrong password
 * produces a different derivedKey and the macs don't match. We surface that
 * as a "wrong password or corrupted keystore" error rather than letting the
 * AES decrypt return garbage that downstream code mistakes for a key.
 *
 * Async because scrypt at ckb-cli's default N=262144 takes ~10s in browser
 * WebAssembly. Caller should show a "decrypting…" UI.
 */
interface KeystoreV3 {
  version: number;
  crypto: {
    cipher: string;
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: string;
    kdfparams: {
      dklen: number;
      n: number;
      r: number;
      p: number;
      salt: string;
    };
    mac: string;
  };
}

export async function decryptCkbCliKeystore(
  jsonString: string,
  password: string,
): Promise<Uint8Array> {
  const ks = JSON.parse(jsonString) as KeystoreV3;
  if (ks.version !== 3) {
    throw new Error(`unsupported keystore version ${ks.version} (expected 3)`);
  }
  const { crypto } = ks;
  if (crypto.cipher !== "aes-128-ctr") {
    throw new Error(`unsupported cipher ${crypto.cipher} (expected aes-128-ctr)`);
  }
  if (crypto.kdf !== "scrypt") {
    throw new Error(`unsupported kdf ${crypto.kdf} (expected scrypt)`);
  }

  const { n, r, p, dklen, salt } = crypto.kdfparams;
  const passwordBytes = new TextEncoder().encode(password);
  const saltBytes = hexToBytes(salt);

  const derived = await scryptAsync(passwordBytes, saltBytes, {
    N: n,
    r,
    p,
    dkLen: dklen,
  });

  const ciphertext = hexToBytes(crypto.ciphertext);
  const macKey = derived.slice(16, 32);
  const macInput = new Uint8Array(macKey.length + ciphertext.length);
  macInput.set(macKey, 0);
  macInput.set(ciphertext, macKey.length);
  const computedMac = keccak_256(macInput);
  const expectedMac = hexToBytes(crypto.mac);

  if (!bytesEqual(computedMac, expectedMac)) {
    throw new Error("keystore MAC mismatch — wrong password or corrupted keystore");
  }

  const encKey = derived.slice(0, 16);
  const iv = hexToBytes(crypto.cipherparams.iv);
  const cipher = ctr(encKey, iv);
  const privateKey = cipher.decrypt(ciphertext);

  if (privateKey.length !== 32) {
    throw new Error(`unexpected decrypted key length: ${privateKey.length} (expected 32)`);
  }
  return privateKey;
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error(`hex string must have even length: ${hex}`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
