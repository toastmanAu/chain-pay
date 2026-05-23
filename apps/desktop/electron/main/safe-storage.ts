import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface SafeStorageProvider {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

class ElectronSafeStorage implements SafeStorageProvider {
  // Lazy require so this module is importable in plain Node (smoke).
  private get safe(): { encryptString: (s: string) => Buffer; decryptString: (b: Buffer) => string; isEncryptionAvailable: () => boolean } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron").safeStorage;
  }
  encrypt(plaintext: string): Buffer {
    return this.safe.encryptString(plaintext);
  }
  decrypt(ciphertext: Buffer): string {
    return this.safe.decryptString(ciphertext);
  }
  isAvailable(): boolean {
    try {
      return this.safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
}

class PassphraseSafeStorage implements SafeStorageProvider {
  private readonly key: Buffer;
  constructor(passphrase: string) {
    // Static salt — this is for smoke use, NOT for production storage.
    this.key = scryptSync(passphrase, "chainpay-comm-smoke-v1", 32);
  }
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // [iv(12) | tag(16) | ct(...)]
    return Buffer.concat([iv, tag, ct]);
  }
  decrypt(ciphertext: Buffer): string {
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const ct = ciphertext.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
  isAvailable(): boolean {
    return true;
  }
}

let cached: SafeStorageProvider | null = null;

export function getSafeStorage(): SafeStorageProvider {
  if (cached) return cached;
  const passphrase = process.env.SMOKE_PASSPHRASE;
  if (passphrase) {
    cached = new PassphraseSafeStorage(passphrase);
  } else {
    cached = new ElectronSafeStorage();
  }
  return cached;
}

/** Test-only: reset the cached provider. */
export function resetSafeStorageForTests(): void {
  cached = null;
}
