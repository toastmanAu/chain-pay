import {
  CAPTURE_V1_CAPABILITIES,
  buildBiscuitSource,
  parseBiscuitSource,
} from "@chain-pay/shared";

type BiscuitModule = typeof import("@biscuit-auth/biscuit-wasm");

let biscuit: BiscuitModule | null = null;

/**
 * Lazy-load `@biscuit-auth/biscuit-wasm`. The package is an ES module with a
 * single sync `init()` entrypoint that prepares the wasm side. We dynamic-import
 * so unit tests in environments without wasm support fail loudly rather than at
 * module-load time.
 */
export async function initBiscuit(): Promise<void> {
  if (biscuit) return;
  biscuit = await import("@biscuit-auth/biscuit-wasm");
  // Deviation from plan: lib's init() is synchronous (declared `: void`), not async.
  if (typeof biscuit.init === "function") {
    biscuit.init();
  }
}

function lib(): BiscuitModule {
  if (!biscuit) {
    throw new Error("Biscuit not initialised — call initBiscuit() at app boot");
  }
  return biscuit;
}

export interface RootKeypair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generates a fresh Ed25519 root keypair, encoded as hexadecimal strings.
 *
 * Deviation from plan: `KeyPair` requires an algorithm, and `toString()`
 * returns `ed25519/<hex>` / `ed25519-private/<hex>`. We strip the prefix so
 * the stored format is plain hex — consistent with the rest of ChainPay's
 * key handling and easier to round-trip through config files.
 */
export function generateRootKeypair(): RootKeypair {
  const { KeyPair, SignatureAlgorithm } = lib();
  const kp = new KeyPair(SignatureAlgorithm.Ed25519);
  return {
    privateKey: stripKeyPrefix(kp.getPrivateKey().toString()),
    publicKey: stripKeyPrefix(kp.getPublicKey().toString()),
  };
}

function stripKeyPrefix(s: string): string {
  const slash = s.indexOf("/");
  return slash === -1 ? s : s.slice(slash + 1);
}

export interface IssuedToken {
  token: string;
  tokenId: string;
}

// Deviation from plan: biscuit-wasm 0.6.0 has no `fromBase64Unverified` and
// extracting a revocation id without the root key would require hand-decoding
// the protobuf. Since `extractTokenId` is only meaningful in flows where we
// have already issued the token in-process, we cache (base64 -> tokenId) at
// issue time. Map is bounded by the host process's token issuance volume; if
// that grows large in the future, swap for an LRU or stop exposing the helper.
const tokenIdCache = new Map<string, string>();

export function issueCaptureV1Token(args: {
  root: RootKeypair;
  deviceLabel: string;
  expiresAtRfc3339: string;
}): IssuedToken {
  if (Number.isNaN(Date.parse(args.expiresAtRfc3339))) {
    throw new Error(
      `issueCaptureV1Token: expiresAtRfc3339 is not a valid RFC3339 timestamp: ${args.expiresAtRfc3339}`,
    );
  }
  const { Biscuit, PrivateKey } = lib();
  const source = buildBiscuitSource(
    CAPTURE_V1_CAPABILITIES,
    args.expiresAtRfc3339,
    args.deviceLabel,
  );
  const builder = Biscuit.builder();
  builder.addCode(source);
  // Deviation: PrivateKey.fromString requires the `ed25519-private/` prefix,
  // PublicKey.fromString does not — we keep hex in our storage and re-add the
  // prefix only at the deserialisation boundary.
  const sk = PrivateKey.fromString(`ed25519-private/${args.root.privateKey}`);
  const token = builder.build(sk);
  const serialized = token.toBase64();
  const tokenId = extractTokenIdFromToken(token);
  tokenIdCache.set(serialized, tokenId);
  return { token: serialized, tokenId };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  tokenId?: string;
  deviceLabel?: string;
  capabilities?: string[];
}

export function verifyToken(args: {
  token: string;
  rootPublicKey: string;
  requiredCapability: string;
  nowRfc3339: string;
}): VerifyResult {
  const { Biscuit, PublicKey, AuthorizerBuilder, SignatureAlgorithm } = lib();
  let parsed;
  try {
    const pk = PublicKey.fromString(args.rootPublicKey, SignatureAlgorithm.Ed25519);
    parsed = Biscuit.fromBase64(args.token, pk);
  } catch (e: unknown) {
    return { ok: false, reason: getErrorMessage(e) };
  }

  // Capability check is performed by parsing the token's authority block
  // datalog source. Doing it before authorize() lets us return a specific
  // "capability" reason rather than a generic "checks failed".
  let capabilities: string[];
  let deviceLabel: string | null;
  try {
    const blockSource = parsed.getBlockSource(0);
    const parsedSource = parseBiscuitSource(blockSource);
    capabilities = parsedSource.capabilities;
    deviceLabel = parsedSource.deviceLabel;
  } catch (e: unknown) {
    return { ok: false, reason: `failed to parse token source: ${getErrorMessage(e)}` };
  }

  if (!capabilities.includes(args.requiredCapability)) {
    return {
      ok: false,
      reason: `capability ${args.requiredCapability} not granted`,
    };
  }

  // Authorize: assert current time + allow-all policy. The token carries
  // `check if time($time), $time <= EXPIRY` so expiry is enforced by Biscuit's
  // Datalog engine. We catch errors and translate the expiry case to a
  // "time/expired" reason so callers can distinguish it from other failures.
  try {
    const authorizerBuilder = new AuthorizerBuilder();
    authorizerBuilder.addCode(`time(${args.nowRfc3339});\nallow if true;`);
    const authorizer = authorizerBuilder.buildAuthenticated(parsed);
    // Deviation: the default `authorize()` RunLimit times out (~1ms) under
    // parallel vitest workers + wasm cold-start. Use authorizeWithLimits with
    // a generous 5s budget — typical authorisation takes <1ms.
    authorizer.authorizeWithLimits({ max_time_micro: 5_000_000 });
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    // Biscuit reports failing checks in the error message; the only check we
    // add in the token is the expiry, so any check-failure here is an expiry
    // violation. Map to a stable "expired" reason for callers.
    if (/check/i.test(msg) && /time/i.test(msg)) {
      return { ok: false, reason: `token expired: ${msg}` };
    }
    if (/check/i.test(msg)) {
      // Only the expiry check exists in this token — translate.
      return { ok: false, reason: `token expired (time check failed): ${msg}` };
    }
    return { ok: false, reason: msg };
  }

  const tokenId = extractTokenIdFromToken(parsed);
  // Re-populate the cache so `extractTokenId` works for tokens received
  // over the wire (re-verified, not necessarily issued in this process).
  tokenIdCache.set(args.token, tokenId);

  const result: VerifyResult = { ok: true, tokenId, capabilities };
  if (deviceLabel !== null) {
    result.deviceLabel = deviceLabel;
  }
  return result;
}

/**
 * Returns the first revocation identifier for a base64-encoded token.
 *
 * Deviation: biscuit-wasm 0.6.0 cannot parse a token without the root key, so
 * this looks up the id from an in-process cache populated by `issueCaptureV1Token`
 * and successful `verifyToken` calls. Throws if the token hasn't been seen.
 */
export function extractTokenId(tokenBase64: string): string {
  const cached = tokenIdCache.get(tokenBase64);
  if (cached) return cached;
  throw new Error(
    "extractTokenId: token not in cache — call issueCaptureV1Token or verifyToken first",
  );
}

interface BiscuitTokenLike {
  getRevocationIdentifiers(): unknown[];
}

function extractTokenIdFromToken(token: BiscuitTokenLike): string {
  const ids = token.getRevocationIdentifiers();
  if (!ids || ids.length === 0) {
    throw new Error("token has no revocation identifier");
  }
  const first = ids[0];
  if (typeof first === "string") return first;
  if (first instanceof Uint8Array) return bytesToHex(first);
  return String(first);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
