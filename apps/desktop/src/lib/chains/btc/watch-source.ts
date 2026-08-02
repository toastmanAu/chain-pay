import { HDKey, type Versions } from "@scure/bip32";
import {
  Address,
  NETWORK,
  TEST_NETWORK,
  p2pkh,
  p2sh,
  p2tr,
  p2wpkh,
} from "@scure/btc-signer";
import type {
  BitcoinAddressScriptType,
  BitcoinChain,
  BitcoinDerivedScriptType,
  BitcoinWatchConfig,
  BitcoinWatchSource,
} from "@chain-pay/shared";

export const DEFAULT_BITCOIN_GAP_LIMIT = 20;
export const MAX_BITCOIN_GAP_LIMIT = 1_000;

const MAINNET_XPUB: Versions = { public: 0x0488b21e, private: 0x0488ade4 };
const TESTNET_TPUB: Versions = { public: 0x043587cf, private: 0x04358394 };
const MAINNET_YPUB: Versions = { public: 0x049d7cb2, private: 0x049d7878 };
const MAINNET_ZPUB: Versions = { public: 0x04b24746, private: 0x04b2430c };
const TESTNET_UPUB: Versions = { public: 0x044a5262, private: 0x044a4e28 };
const TESTNET_VPUB: Versions = { public: 0x045f1cf6, private: 0x045f18bc };

const EXTENDED_PUBLIC_VERSIONS: Record<
  string,
  { chain: BitcoinChain; versions: Versions; impliedScript?: BitcoinDerivedScriptType }
> = {
  xpub: { chain: "btc:mainnet", versions: MAINNET_XPUB },
  ypub: { chain: "btc:mainnet", versions: MAINNET_YPUB, impliedScript: "p2sh-p2wpkh" },
  zpub: { chain: "btc:mainnet", versions: MAINNET_ZPUB, impliedScript: "p2wpkh" },
  tpub: { chain: "btc:testnet", versions: TESTNET_TPUB },
  upub: { chain: "btc:testnet", versions: TESTNET_UPUB, impliedScript: "p2sh-p2wpkh" },
  vpub: { chain: "btc:testnet", versions: TESTNET_VPUB, impliedScript: "p2wpkh" },
};

const PRIVATE_EXTENDED_KEY = /\b(?:xprv|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]+\b/i;
const PRIVATE_WIF = /\b(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL9c][1-9A-HJ-NP-Za-km-z]{51})\b/;
const RAW_PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;
const EXTENDED_PUBLIC_KEY = /\b(?:xpub|ypub|zpub|tpub|upub|vpub)[1-9A-HJ-NP-Za-km-z]+\b/;
const DESCRIPTOR_CHECKSUM_RE = /^[023456789acdefghjklmnpqrstuvwxyz]{8}$/;

export type BitcoinWatchImport =
  | { kind: "address"; value: string; chain: BitcoinChain; scriptType: BitcoinAddressScriptType }
  | {
      kind: "descriptor";
      value: string;
      chain: BitcoinChain;
      scriptType: BitcoinDerivedScriptType;
      gapLimit?: number;
    }
  | {
      kind: "xpub";
      value: string;
      chain: BitcoinChain;
      scriptType: BitcoinDerivedScriptType;
      /** Defaults to the account's external receive branch, `0/*`. */
      derivationPath?: number[];
      gapLimit?: number;
    };

export function parseBitcoinWatchImport(input: BitcoinWatchImport): BitcoinWatchConfig {
  rejectSecretMaterial(input.value);
  const gapLimit = validateGapLimit(input.kind === "address" ? DEFAULT_BITCOIN_GAP_LIMIT : input.gapLimit);

  if (input.kind === "address") {
    const parsed = parseBitcoinAddress(input.value, input.chain);
    if (parsed.scriptType !== input.scriptType) {
      throw new Error(`Bitcoin address is ${parsed.scriptType}, not ${input.scriptType}`);
    }
    return { chain: input.chain, gapLimit, source: parsed };
  }

  if (input.kind === "xpub") {
    const derivationPath = input.derivationPath ?? [0];
    validateDerivationPath(derivationPath);
    const key = parseExtendedPublicKey(input.value.trim(), input.chain, input.scriptType);
    const keyExpression = `${key.value}${derivationPath.map((part) => `/${part}`).join("")}/*`;
    const body = wrapDescriptor(input.scriptType, keyExpression);
    return {
      chain: input.chain,
      gapLimit,
      source: {
        kind: "descriptor",
        descriptor: addDescriptorChecksum(body),
        scriptType: input.scriptType,
        extendedPublicKey: key.value,
        derivationPath,
      },
    };
  }

  const parsed = parseDescriptor(input.value, input.chain, input.scriptType);
  return { chain: input.chain, gapLimit, source: parsed };
}

export function parseBitcoinAddress(
  value: string,
  chain: BitcoinChain,
): Extract<BitcoinWatchSource, { kind: "address" }> {
  const address = value.trim();
  if (address !== value.trim() || address.length === 0) throw new Error("Bitcoin address is empty");
  const coder = Address(networkFor(chain));
  let decoded: ReturnType<typeof coder.decode>;
  try {
    decoded = coder.decode(address);
  } catch {
    throw new Error(`Invalid ${networkLabel(chain)} Bitcoin address`);
  }
  if (!decoded) throw new Error("Unsupported Bitcoin address script type");
  const scriptType = addressScriptType(decoded.type);
  return { kind: "address", address: coder.encode(decoded), scriptType };
}

export function deriveBitcoinReceiveAddress(
  config: BitcoinWatchConfig,
  index: number,
): string {
  if (config.source.kind !== "descriptor") {
    if (index !== 0) throw new Error("A fixed-address watch source cannot derive receive addresses");
    return config.source.address;
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("Bitcoin receive index must be a non-hardened uint31");
  }
  const parsedKey = parseExtendedPublicKey(
    config.source.extendedPublicKey,
    config.chain,
    config.source.scriptType,
  );
  let node = parsedKey.node;
  for (const part of config.source.derivationPath) node = node.deriveChild(part);
  node = node.deriveChild(index);
  const publicKey = node.publicKey;
  if (!publicKey) throw new Error("Extended public key did not derive a public key");
  const network = networkFor(config.chain);

  switch (config.source.scriptType) {
    case "p2pkh":
      return p2pkh(publicKey, network).address;
    case "p2sh-p2wpkh":
      return p2sh(p2wpkh(publicKey, network), network).address;
    case "p2wpkh":
      return p2wpkh(publicKey, network).address;
    case "p2tr":
      return p2tr(publicKey.slice(1), undefined, network).address;
  }
}

export function bitcoinWatchIdentity(config: BitcoinWatchConfig): string {
  const value = config.source.kind === "address" ? config.source.address : config.source.descriptor;
  return `${config.chain}:${config.source.kind}:${value}`;
}

export function addDescriptorChecksum(body: string): string {
  if (body.includes("#")) throw new Error("Descriptor body must not contain a checksum separator");
  const checksum = descriptorChecksum(body);
  if (!checksum) throw new Error("Descriptor contains characters outside the BIP-380 character set");
  return `${body}#${checksum}`;
}

export function descriptorChecksum(descriptor: string): string | null {
  const inputCharset =
    "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\\ \"";
  const checksumCharset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  let checksum = 1n;
  let cls = 0;
  let clsCount = 0;
  for (const char of descriptor) {
    const position = inputCharset.indexOf(char);
    if (position === -1) return null;
    checksum = descriptorPolyMod(checksum, position & 31);
    cls = cls * 3 + (position >> 5);
    if (++clsCount === 3) {
      checksum = descriptorPolyMod(checksum, cls);
      cls = 0;
      clsCount = 0;
    }
  }
  if (clsCount > 0) checksum = descriptorPolyMod(checksum, cls);
  for (let i = 0; i < 8; i++) checksum = descriptorPolyMod(checksum, 0);
  checksum ^= 1n;
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += checksumCharset[Number((checksum >> BigInt(5 * (7 - i))) & 31n)];
  }
  return result;
}

function parseDescriptor(
  value: string,
  chain: BitcoinChain,
  expectedScript: BitcoinDerivedScriptType,
): Extract<BitcoinWatchSource, { kind: "descriptor" }> {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("#");
  const body = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const suppliedChecksum = separator === -1 ? undefined : trimmed.slice(separator + 1);
  if (!body || body.includes("#")) throw new Error("Malformed Bitcoin output descriptor");
  const checksum = descriptorChecksum(body);
  if (!checksum) throw new Error("Descriptor contains unsupported characters");
  if (suppliedChecksum !== undefined) {
    if (!DESCRIPTOR_CHECKSUM_RE.test(suppliedChecksum) || suppliedChecksum !== checksum) {
      throw new Error("Bitcoin descriptor checksum is invalid");
    }
  }

  const unwrapped = unwrapDescriptor(body);
  if (unwrapped.scriptType !== expectedScript) {
    throw new Error(`Bitcoin descriptor is ${unwrapped.scriptType}, not ${expectedScript}`);
  }
  const keyMatch = unwrapped.keyExpression.match(
    /^(?:\[([0-9a-fA-F]{8}(?:\/[0-9]+(?:['hH])?)*)\])?((?:xpub|ypub|zpub|tpub|upub|vpub)[1-9A-HJ-NP-Za-km-z]+)((?:\/[0-9]+)*)\/\*$/,
  );
  if (!keyMatch) {
    throw new Error("Descriptor must contain one public extended key and a final /* wildcard");
  }
  const keyOrigin = keyMatch[1];
  const extendedPublicKey = keyMatch[2];
  if (!extendedPublicKey) throw new Error("Descriptor extended public key is missing");
  parseExtendedPublicKey(extendedPublicKey, chain, expectedScript);
  const derivationPath = (keyMatch[3] ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => Number(part));
  validateDerivationPath(derivationPath);

  return {
    kind: "descriptor",
    descriptor: `${body}#${checksum}`,
    scriptType: expectedScript,
    extendedPublicKey,
    derivationPath,
    ...(keyOrigin ? { keyOrigin: keyOrigin.toLowerCase().replaceAll("'", "h") } : {}),
  };
}

function unwrapDescriptor(body: string): {
  scriptType: BitcoinDerivedScriptType;
  keyExpression: string;
} {
  const wrappers: [string, BitcoinDerivedScriptType][] = [
    ["sh(wpkh(", "p2sh-p2wpkh"],
    ["wpkh(", "p2wpkh"],
    ["pkh(", "p2pkh"],
    ["tr(", "p2tr"],
  ];
  for (const [prefix, scriptType] of wrappers) {
    const suffix = scriptType === "p2sh-p2wpkh" ? "))" : ")";
    if (body.startsWith(prefix) && body.endsWith(suffix)) {
      return { scriptType, keyExpression: body.slice(prefix.length, -suffix.length) };
    }
  }
  throw new Error("Unsupported Bitcoin descriptor; use pkh, sh(wpkh), wpkh, or tr");
}

function wrapDescriptor(scriptType: BitcoinDerivedScriptType, key: string): string {
  switch (scriptType) {
    case "p2pkh":
      return `pkh(${key})`;
    case "p2sh-p2wpkh":
      return `sh(wpkh(${key}))`;
    case "p2wpkh":
      return `wpkh(${key})`;
    case "p2tr":
      return `tr(${key})`;
  }
}

function parseExtendedPublicKey(
  value: string,
  chain: BitcoinChain,
  scriptType: BitcoinDerivedScriptType,
): { value: string; node: HDKey } {
  const match = value.match(EXTENDED_PUBLIC_KEY);
  if (!match || match[0] !== value) throw new Error("A supported public extended key is required");
  const prefix = value.slice(0, 4);
  const metadata = EXTENDED_PUBLIC_VERSIONS[prefix];
  if (!metadata) throw new Error("Unsupported extended public key version");
  if (metadata.chain !== chain) throw new Error(`Extended public key belongs to ${networkLabel(metadata.chain)}`);
  if (metadata.impliedScript && metadata.impliedScript !== scriptType) {
    throw new Error(`${prefix} implies ${metadata.impliedScript}, not ${scriptType}`);
  }
  try {
    const node = HDKey.fromExtendedKey(value, metadata.versions);
    if (node.privateKey) throw new Error("Private extended keys are not permitted");
    if (!node.publicKey) throw new Error("Extended public key has no public key data");
    return { value, node };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not permitted")) throw error;
    throw new Error("Invalid Bitcoin extended public key");
  }
}

function rejectSecretMaterial(value: string): void {
  const trimmed = value.trim();
  if (PRIVATE_EXTENDED_KEY.test(trimmed)) throw new Error("Private extended keys are not permitted");
  if (PRIVATE_WIF.test(trimmed) || RAW_PRIVATE_KEY.test(trimmed)) {
    throw new Error("Bitcoin private keys are not permitted");
  }
  const words = trimmed.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((word) => /^[a-z]+$/i.test(word))) {
    throw new Error("Seed or mnemonic material is not permitted");
  }
}

function validateGapLimit(value: number | undefined): number {
  const gapLimit = value ?? DEFAULT_BITCOIN_GAP_LIMIT;
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > MAX_BITCOIN_GAP_LIMIT) {
    throw new Error(`Bitcoin gap limit must be an integer from 1 to ${MAX_BITCOIN_GAP_LIMIT}`);
  }
  return gapLimit;
}

function validateDerivationPath(path: number[]): void {
  if (path.length > 16) throw new Error("Bitcoin public derivation path is too deep");
  for (const part of path) {
    if (!Number.isSafeInteger(part) || part < 0 || part >= 0x80000000) {
      throw new Error("Only non-hardened public derivation is permitted after an xpub");
    }
  }
}

function addressScriptType(type: string): BitcoinAddressScriptType {
  switch (type) {
    case "pkh":
      return "p2pkh";
    case "sh":
      return "p2sh";
    case "wpkh":
      return "p2wpkh";
    case "wsh":
      return "p2wsh";
    case "tr":
      return "p2tr";
    default:
      throw new Error("Unsupported Bitcoin address script type");
  }
}

function networkFor(chain: BitcoinChain) {
  return chain === "btc:mainnet" ? NETWORK : TEST_NETWORK;
}

function networkLabel(chain: BitcoinChain): "mainnet" | "testnet" {
  return chain === "btc:mainnet" ? "mainnet" : "testnet";
}

function descriptorPolyMod(checksum: bigint, value: number): bigint {
  const top = checksum >> 35n;
  let result = ((checksum & 0x7ffffffffn) << 5n) ^ BigInt(value);
  if (top & 1n) result ^= 0xf5dee51989n;
  if (top & 2n) result ^= 0xa9fdca3312n;
  if (top & 4n) result ^= 0x1bab10e32dn;
  if (top & 8n) result ^= 0x3706b1677an;
  if (top & 16n) result ^= 0x644d626ffdn;
  return result;
}
