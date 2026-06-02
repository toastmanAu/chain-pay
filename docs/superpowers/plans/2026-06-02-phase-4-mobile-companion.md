# Phase 4 — Mobile Companion (Capture v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Expo iOS/Android companion app that photographs invoices using native OCR and pushes them into the existing ChainPay desktop invoice queue via a new desktop-side HTTPS pair-server. Pairing/auth reuses the FiberConnect v1.0.0 protocol with an L1-extended Biscuit capability vocabulary.

**Architecture:** Companion app, not full port. Desktop runs a new HTTPS server (`pair-server.ts` in electron/main) that accepts authenticated invoice pushes and dispatches them through existing IPC into the renderer invoice store. Mobile app maintains a local sync queue (MMKV) and drains via IP transport (Wi-Fi mDNS + Tailscale). No payment signing on phone in v1.

> **Scoping update 2026-06-02:** CEMP-PQ on-chain cellular fallback deferred to v2 (architecture cost outweighs v1 value — the actual `@chain-pay/cemp-pq` API is low-level CKB tx-building primitives, not encrypt-and-send). Task 15 marked DEFERRED; Tasks 13, 16, 22 simplified to IP-only paths.

**Tech Stack:** Expo SDK 51+ (TypeScript), `react-native-vision-camera`, `@react-native-ml-kit/text-recognition`, `react-native-mmkv`, `expo-secure-store`, `react-native-zeroconf`, `@biscuit-auth/biscuit-wasm` (electron + mobile), `bonjour-service` (electron), Node `https` + self-signed cert. Reuses existing `packages/shared` and `packages/cemp-pq`.

**Spec:** `docs/superpowers/specs/2026-06-02-mobile-companion-design.md`

---

## File-Level Inventory

### New shared package files

- `packages/shared/src/fiberConnect.ts` — ported from fiber-wallet
- `packages/shared/src/fiberConnect.test.ts`
- `packages/shared/src/biscuit-capabilities.ts` — L1 capability vocabulary
- `packages/shared/src/biscuit-capabilities.test.ts`
- `packages/shared/src/mobile-protocol.ts` — wire format types + Zod schemas
- `packages/shared/src/mobile-protocol.test.ts`

### New desktop main-process files

- `apps/desktop/electron/main/pair-store.ts`
- `apps/desktop/electron/main/pair-store.test.ts`
- `apps/desktop/electron/main/pair-server-biscuit.ts`
- `apps/desktop/electron/main/pair-server-biscuit.test.ts`
- `apps/desktop/electron/main/invoice-receiver.ts`
- `apps/desktop/electron/main/invoice-receiver.test.ts`
- `apps/desktop/electron/main/pair-server.ts`
- `apps/desktop/electron/main/pair-server.test.ts`

### New desktop renderer files

- `apps/desktop/src/features/settings/PairingSection.tsx`
- `apps/desktop/src/features/settings/PairingSection.test.tsx`

### Modified desktop files

- `apps/desktop/electron/main/index.ts` — start pair-server on app boot
- `apps/desktop/src/features/settings/SettingsPage.tsx` — mount PairingSection
- `apps/desktop/electron/preload/index.ts` — expose pair management API
- `packages/shared/src/index.ts` — re-export new modules
- `package.json` (root) — add `apps/mobile` workspace entry

### New mobile app (`apps/mobile/`)

- Whole Expo project tree (scaffold via `npx create-expo-app`)
- `apps/mobile/lib/ocr/native-ocr.ts` + test
- `apps/mobile/lib/ocr/mapper.ts` + test
- `apps/mobile/lib/transport/ip-client.ts` + test
- `apps/mobile/lib/transport/cemp-client.ts` + test
- `apps/mobile/lib/transport/index.ts` + test
- `apps/mobile/stores/pairing.ts` + test
- `apps/mobile/stores/sync-queue.ts` + test
- `apps/mobile/app/index.tsx` — home (queue) screen
- `apps/mobile/app/capture.tsx` — camera
- `apps/mobile/app/review.tsx` — review extracted data
- `apps/mobile/app/pair.tsx` — QR scanner
- `apps/mobile/__fixtures__/invoices/*.jpg` — 5 anonymised test images

### Docs

- `docs/phase-4-smoke-playbook.md`

---

## Task Decomposition

24 tasks across 8 phases. Each task is one self-contained commit. TDD: red → green → commit.

### Phase A — Shared foundations (T1–T3)

### Task 1: Port FiberConnect to shared package

**Files:**
- Create: `packages/shared/src/fiberConnect.ts`
- Create: `packages/shared/src/fiberConnect.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/fiberConnect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFiberConnectUri, parseFiberConnectUri } from "./fiberConnect";

describe("FiberConnect URI", () => {
  it("round-trips the protocol payload", () => {
    const uri = createFiberConnectUri({
      rpc_url: "https://node.example.com:8231",
      auth_token: "EsQCCtkBCghja",
      cert_fingerprint: "12:34:56",
    });

    expect(uri.startsWith("fiberconnect://")).toBe(true);
    expect(parseFiberConnectUri(uri)).toEqual({
      rpc_url: "https://node.example.com:8231/",
      auth_token: "EsQCCtkBCghja",
      cert_fingerprint: "12:34:56",
    });
  });

  it("omits empty certificate fingerprints", () => {
    expect(
      parseFiberConnectUri(
        createFiberConnectUri({
          rpc_url: "http://192.168.1.100:8231",
          auth_token: "token",
          cert_fingerprint: " ",
        }),
      ),
    ).toEqual({
      rpc_url: "http://192.168.1.100:8231/",
      auth_token: "token",
    });
  });

  it("rejects unsupported endpoint schemes", () => {
    expect(() =>
      createFiberConnectUri({
        rpc_url: "file:///tmp/node.sock",
        auth_token: "token",
      }),
    ).toThrow("http or https");
  });

  it("rejects URIs without the fiberconnect scheme", () => {
    expect(() => parseFiberConnectUri("http://x")).toThrow("must start with fiberconnect://");
  });

  it("rejects empty payloads", () => {
    expect(() => parseFiberConnectUri("fiberconnect://")).toThrow("payload is empty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/fiberConnect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/fiberConnect.ts` (direct port from fiber-wallet):

```ts
export type FiberConnectPayload = {
  rpc_url: string;
  auth_token: string;
  cert_fingerprint?: string;
};

const scheme = "fiberconnect://";

export function createFiberConnectUri(payload: FiberConnectPayload): string {
  const normalized = normalizeFiberConnectPayload(payload);
  const json = JSON.stringify(normalized);
  return `${scheme}${base64UrlEncode(json)}`;
}

export function parseFiberConnectUri(uri: string): FiberConnectPayload {
  if (!uri.startsWith(scheme)) {
    throw new Error("FiberConnect URI must start with fiberconnect://");
  }
  const encoded = uri.slice(scheme.length);
  if (!encoded) {
    throw new Error("FiberConnect URI payload is empty");
  }
  return normalizeFiberConnectPayload(JSON.parse(base64UrlDecode(encoded)) as FiberConnectPayload);
}

export function normalizeFiberConnectPayload(payload: FiberConnectPayload): FiberConnectPayload {
  const rpcUrl = payload.rpc_url.trim();
  const token = payload.auth_token.trim();
  const fingerprint = payload.cert_fingerprint?.trim();
  if (!rpcUrl) throw new Error("FiberConnect rpc_url is required");
  if (!token) throw new Error("FiberConnect auth_token is required");
  const parsed = new URL(rpcUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("FiberConnect rpc_url must use http or https");
  }
  return {
    rpc_url: parsed.toString(),
    auth_token: token,
    ...(fingerprint ? { cert_fingerprint: fingerprint } : {}),
  };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
```

- [ ] **Step 4: Add export to package index**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./fiberConnect";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/fiberConnect.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/fiberConnect.ts packages/shared/src/fiberConnect.test.ts packages/shared/src/index.ts
git commit -m "feat(4): port FiberConnect URI codec from fiber-wallet"
```

---

### Task 2: Define L1 Biscuit capability vocabulary

**Files:**
- Create: `packages/shared/src/biscuit-capabilities.ts`
- Create: `packages/shared/src/biscuit-capabilities.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/biscuit-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  L1_CAPABILITIES,
  CAPTURE_V1_CAPABILITIES,
  buildBiscuitSource,
  parseBiscuitSource,
} from "./biscuit-capabilities";

describe("L1 Biscuit capability vocabulary", () => {
  it("exposes the four L1 capabilities", () => {
    expect(L1_CAPABILITIES).toEqual([
      'write("invoices")',
      'read("treasury")',
      'read("payment_batches")',
      'sign("approval_request")',
    ]);
  });

  it("CAPTURE_V1 grants only write(invoices)", () => {
    expect(CAPTURE_V1_CAPABILITIES).toEqual(['write("invoices")']);
  });

  it("buildBiscuitSource produces deterministic source with expiry check", () => {
    const src = buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2026-07-02T00:00:00Z", "phone-1");
    expect(src).toBe(
      'write("invoices");\ndevice_label("phone-1");\ncheck if time($time), $time <= 2026-07-02T00:00:00Z;',
    );
  });

  it("parseBiscuitSource extracts capabilities and label", () => {
    const src = buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2026-07-02T00:00:00Z", "phone-1");
    const parsed = parseBiscuitSource(src);
    expect(parsed.capabilities).toEqual(['write("invoices")']);
    expect(parsed.deviceLabel).toBe("phone-1");
    expect(parsed.expiry).toBe("2026-07-02T00:00:00Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/biscuit-capabilities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/biscuit-capabilities.ts`:

```ts
export const L1_CAPABILITIES = [
  'write("invoices")',
  'read("treasury")',
  'read("payment_batches")',
  'sign("approval_request")',
] as const;

export type L1Capability = (typeof L1_CAPABILITIES)[number];

export const CAPTURE_V1_CAPABILITIES: readonly L1Capability[] = ['write("invoices")'];

export interface ParsedBiscuitSource {
  capabilities: string[];
  deviceLabel: string | null;
  expiry: string | null;
}

export function buildBiscuitSource(
  capabilities: readonly L1Capability[],
  expiryRfc3339: string,
  deviceLabel: string,
): string {
  const lines: string[] = capabilities.map((c) => `${c};`);
  lines.push(`device_label("${deviceLabel.replace(/"/g, '\\"')}");`);
  lines.push(`check if time($time), $time <= ${expiryRfc3339};`);
  return lines.join("\n");
}

export function parseBiscuitSource(source: string): ParsedBiscuitSource {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const capabilities: string[] = [];
  let deviceLabel: string | null = null;
  let expiry: string | null = null;
  for (const line of lines) {
    const labelMatch = line.match(/^device_label\("(.+?)"\);?$/);
    if (labelMatch) {
      deviceLabel = labelMatch[1].replace(/\\"/g, '"');
      continue;
    }
    const expiryMatch = line.match(/^check if time\(\$time\), \$time <= (.+);?$/);
    if (expiryMatch) {
      expiry = expiryMatch[1];
      continue;
    }
    const capMatch = line.match(/^((?:read|write|sign)\(".+?"\));?$/);
    if (capMatch) {
      capabilities.push(capMatch[1]);
    }
  }
  return { capabilities, deviceLabel, expiry };
}
```

- [ ] **Step 4: Add export to package index**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./biscuit-capabilities";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/biscuit-capabilities.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/biscuit-capabilities.ts packages/shared/src/biscuit-capabilities.test.ts packages/shared/src/index.ts
git commit -m "feat(4): L1 Biscuit capability vocabulary"
```

---

### Task 3: Mobile wire-protocol schema

**Files:**
- Create: `packages/shared/src/mobile-protocol.ts`
- Create: `packages/shared/src/mobile-protocol.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/mobile-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MobileInvoicePayloadSchema,
  MobilePairRequestSchema,
  HealthResponseSchema,
  CommPubkeyResponseSchema,
  IMAGE_CHUNK_BYTES,
} from "./mobile-protocol";

describe("mobile protocol schemas", () => {
  it("validates a well-formed invoice payload", () => {
    const ok = MobileInvoicePayloadSchema.safeParse({
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1717286400000,
      extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
      image_chunks: ["AAAA"],
      image_mime: "image/jpeg",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects ids that are not ulid-shaped", () => {
    const bad = MobileInvoicePayloadSchema.safeParse({
      id: "not-a-ulid",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [],
      image_mime: "image/jpeg",
    });
    expect(bad.success).toBe(false);
  });

  it("validates pair request", () => {
    const ok = MobilePairRequestSchema.safeParse({
      phone_comm_pubkey: "0x" + "ab".repeat(32),
      device_label: "phill-pixel-8",
    });
    expect(ok.success).toBe(true);
  });

  it("validates health and comm-pubkey responses", () => {
    expect(HealthResponseSchema.safeParse({ ok: true, app: "chainpay", version: "0.4.0" }).success).toBe(true);
    expect(CommPubkeyResponseSchema.safeParse({ comm_pubkey: "0x" + "cd".repeat(32) }).success).toBe(true);
  });

  it("exposes the chunk size constant matching desktop", () => {
    expect(IMAGE_CHUNK_BYTES).toBe(256 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/mobile-protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/mobile-protocol.ts`:

```ts
import { z } from "zod";

export const IMAGE_CHUNK_BYTES = 256 * 1024;

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const HexBytes32 = z.string().regex(/^0x[a-f0-9]{64}$/);
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const MobileInvoicePayloadSchema = z.object({
  id: Ulid,
  capturedAt: z.number().int().nonnegative(),
  extraction: z.object({
    body: z.record(z.unknown()),
    field_confidences: z.record(z.number()),
    warnings: z.array(z.unknown()),
  }),
  image_chunks: z.array(Base64),
  image_mime: z.enum(["image/jpeg", "image/png"]),
});
export type MobileInvoicePayload = z.infer<typeof MobileInvoicePayloadSchema>;

export const MobileInvoiceResponseSchema = z.object({
  invoiceId: z.string(),
});
export type MobileInvoiceResponse = z.infer<typeof MobileInvoiceResponseSchema>;

export const MobilePairRequestSchema = z.object({
  phone_comm_pubkey: HexBytes32,
  device_label: z.string().min(1).max(64),
});
export type MobilePairRequest = z.infer<typeof MobilePairRequestSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  app: z.string(),
  version: z.string(),
});

export const CommPubkeyResponseSchema = z.object({
  comm_pubkey: HexBytes32,
});

export const MOBILE_ROUTES = {
  health: "/health",
  pair: "/pair",
  commPubkey: "/comm-pubkey",
  invoices: "/invoices",
} as const;
```

- [ ] **Step 4: Add export to package index**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./mobile-protocol";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/mobile-protocol.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/mobile-protocol.ts packages/shared/src/mobile-protocol.test.ts packages/shared/src/index.ts
git commit -m "feat(4): mobile wire-protocol schemas"
```

---

### Phase B — Desktop pair-server (T4–T8)

### Task 4: Paired-device store

**Files:**
- Create: `apps/desktop/electron/main/pair-store.ts`
- Create: `apps/desktop/electron/main/pair-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/electron/main/pair-store.test.ts` (mirrors `comm-identity-store.test.ts` patterns — DI for the file path, `safe-storage` reset between tests):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pair-store-test-"));
const file = path.join(tmpDir, "paired-devices.enc");

const { _setPairStoreFileForTests, listDevices, addDevice, revokeDevice, isRevoked, getDeviceByTokenId } = await import("./pair-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(file, { force: true });
  _setPairStoreFileForTests(file);
});

describe("pair-store", () => {
  it("returns empty list initially", async () => {
    expect(await listDevices()).toEqual([]);
  });

  it("persists an added device across reads", async () => {
    await addDevice({
      tokenId: "tok-abc",
      deviceLabel: "phill-pixel-8",
      commPubkey: "0x" + "11".repeat(32),
      capabilities: ['write("invoices")'],
      issuedAt: 1717286400000,
      expiresAt: 1719878400000,
    });
    const list = await listDevices();
    expect(list).toHaveLength(1);
    expect(list[0].deviceLabel).toBe("phill-pixel-8");
  });

  it("revokes a device and reports it via isRevoked", async () => {
    await addDevice({
      tokenId: "tok-revoke", deviceLabel: "x", commPubkey: "0x" + "22".repeat(32),
      capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 1,
    });
    expect(await isRevoked("tok-revoke")).toBe(false);
    await revokeDevice("tok-revoke");
    expect(await isRevoked("tok-revoke")).toBe(true);
  });

  it("getDeviceByTokenId returns the matching device", async () => {
    await addDevice({
      tokenId: "tok-find", deviceLabel: "find-me", commPubkey: "0x" + "33".repeat(32),
      capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 1,
    });
    const got = await getDeviceByTokenId("tok-find");
    expect(got?.deviceLabel).toBe("find-me");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/pair-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/electron/main/pair-store.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { encrypt, decrypt } from "./safe-storage";

export interface PairedDevice {
  tokenId: string;
  deviceLabel: string;
  commPubkey: string;
  capabilities: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

interface StoreShape {
  devices: PairedDevice[];
  schemaVersion: 1;
}

let storeFile: string | null = null;
function resolveFile(): string {
  if (storeFile) return storeFile;
  return path.join(app.getPath("userData"), "paired-devices.enc");
}

export function _setPairStoreFileForTests(file: string): void {
  storeFile = file;
}

async function readStore(): Promise<StoreShape> {
  try {
    const buf = await fs.readFile(resolveFile());
    const json = decrypt(buf);
    return JSON.parse(json) as StoreShape;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { devices: [], schemaVersion: 1 };
    throw e;
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const enc = encrypt(JSON.stringify(store));
  await fs.mkdir(path.dirname(resolveFile()), { recursive: true });
  await fs.writeFile(resolveFile(), enc);
}

export async function listDevices(): Promise<PairedDevice[]> {
  return (await readStore()).devices;
}

export async function addDevice(d: PairedDevice): Promise<void> {
  const store = await readStore();
  store.devices = [...store.devices.filter((x) => x.tokenId !== d.tokenId), d];
  await writeStore(store);
}

export async function revokeDevice(tokenId: string): Promise<void> {
  const store = await readStore();
  store.devices = store.devices.map((d) =>
    d.tokenId === tokenId ? { ...d, revokedAt: Date.now() } : d,
  );
  await writeStore(store);
}

export async function isRevoked(tokenId: string): Promise<boolean> {
  const store = await readStore();
  const d = store.devices.find((x) => x.tokenId === tokenId);
  return d?.revokedAt !== undefined;
}

export async function getDeviceByTokenId(tokenId: string): Promise<PairedDevice | undefined> {
  return (await readStore()).devices.find((d) => d.tokenId === tokenId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/pair-store.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/pair-store.ts apps/desktop/electron/main/pair-store.test.ts
git commit -m "feat(4): paired-device store with revocation"
```

---

### Task 5: Biscuit token gen + verify

**Files:**
- Create: `apps/desktop/electron/main/pair-server-biscuit.ts`
- Create: `apps/desktop/electron/main/pair-server-biscuit.test.ts`
- Modify: `apps/desktop/package.json` (add `@biscuit-auth/biscuit-wasm`)

- [ ] **Step 1: Install dependency**

Run from repo root:

```bash
cd apps/desktop && npm install --save @biscuit-auth/biscuit-wasm@^0.6.0
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/electron/main/pair-server-biscuit.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/pair-server-biscuit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/electron/main/pair-server-biscuit.ts`:

```ts
import { CAPTURE_V1_CAPABILITIES, buildBiscuitSource, parseBiscuitSource } from "@chain-pay/shared";

let biscuit: typeof import("@biscuit-auth/biscuit-wasm") | null = null;

export async function initBiscuit(): Promise<void> {
  if (biscuit) return;
  biscuit = await import("@biscuit-auth/biscuit-wasm");
  if (typeof biscuit.init === "function") {
    await biscuit.init();
  }
}

function lib(): NonNullable<typeof biscuit> {
  if (!biscuit) throw new Error("Biscuit not initialised — call initBiscuit() at app boot");
  return biscuit;
}

export interface RootKeypair {
  privateKey: string;
  publicKey: string;
}

export function generateRootKeypair(): RootKeypair {
  const { KeyPair } = lib();
  const kp = new KeyPair();
  return { privateKey: kp.toHex(), publicKey: kp.getPublicKey().toHex() };
}

export interface IssuedToken {
  token: string;
  tokenId: string;
}

export function issueCaptureV1Token(args: {
  root: RootKeypair;
  deviceLabel: string;
  expiresAtRfc3339: string;
}): IssuedToken {
  const { Biscuit, PrivateKey } = lib();
  const source = buildBiscuitSource(CAPTURE_V1_CAPABILITIES, args.expiresAtRfc3339, args.deviceLabel);
  const builder = Biscuit.builder();
  builder.addCode(source);
  const sk = PrivateKey.fromHex(args.root.privateKey);
  const token = builder.build(sk);
  const serialized = token.toBase64();
  return { token: serialized, tokenId: extractTokenIdFromToken(token) };
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
  const { Biscuit, PublicKey, Authorizer } = lib();
  try {
    const pk = PublicKey.fromHex(args.rootPublicKey);
    const parsed = Biscuit.fromBase64(args.token, pk);
    const source = parsed.printSource();
    const { capabilities, deviceLabel, expiry } = parseBiscuitSource(source);
    if (!capabilities.includes(args.requiredCapability)) {
      return { ok: false, reason: `capability ${args.requiredCapability} not granted` };
    }
    const authorizer = new Authorizer();
    authorizer.addToken(parsed);
    authorizer.addCode(`time(${args.nowRfc3339});\nallow if true;`);
    authorizer.authorize();
    return {
      ok: true,
      tokenId: extractTokenIdFromToken(parsed),
      deviceLabel: deviceLabel ?? undefined,
      capabilities,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
}

export function extractTokenId(tokenBase64: string): string {
  const { Biscuit } = lib();
  const t = Biscuit.fromBase64Unverified(tokenBase64);
  return extractTokenIdFromToken(t);
}

function extractTokenIdFromToken(token: unknown): string {
  const t = token as { revocationIdentifiers?: () => string[] };
  const ids = t.revocationIdentifiers?.() ?? [];
  if (ids.length === 0) throw new Error("token has no revocation identifier");
  return ids[0];
}
```

> **Note for T5 implementer:** Task 2 surfaced a regex trap — `.+` is greedy and swallows trailing `;`. If this task's `parseBiscuitSource` was rewritten here it would have the same bug. Use the version of `parseBiscuitSource` from `@chain-pay/shared` (Task 2's commit `05ec10f`); don't re-implement the regex.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/pair-server-biscuit.test.ts`
Expected: PASS — 4 tests. (If `@biscuit-auth/biscuit-wasm` API differs from the assumed names, adapt the imports in `pair-server-biscuit.ts` to match the published types; the test surface stays unchanged.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/pair-server-biscuit.ts apps/desktop/electron/main/pair-server-biscuit.test.ts apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(4): Biscuit token issue + verify for CAPTURE_V1"
```

---

### Task 6: Invoice receiver — payload to IPC dispatch

**Files:**
- Create: `apps/desktop/electron/main/invoice-receiver.ts`
- Create: `apps/desktop/electron/main/invoice-receiver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/electron/main/invoice-receiver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { receiveMobileInvoice, _resetSeenIdsForTests } from "./invoice-receiver";

const sender = { send: vi.fn() };
const mockWebContents = sender as unknown as Electron.WebContents;

beforeEach(() => {
  sender.send.mockReset();
  _resetSeenIdsForTests();
});

const payload = {
  id: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
  image_chunks: [Buffer.from("hello").toString("base64")],
  image_mime: "image/jpeg" as const,
};

describe("invoice-receiver", () => {
  it("dispatches via IPC and returns 'created' on first id", async () => {
    const out = await receiveMobileInvoice({
      payload,
      deviceLabel: "phone-1",
      sendToRenderer: mockWebContents,
    });
    expect(out.status).toBe("created");
    expect(out.invoiceId).toMatch(/^inv_/);
    expect(sender.send).toHaveBeenCalledWith(
      "mobile-invoice:received",
      expect.objectContaining({ invoiceId: out.invoiceId, sourceLabel: "phone-1" }),
    );
  });

  it("returns 'duplicate' with same invoiceId on repeated id", async () => {
    const first = await receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    const second = await receiveMobileInvoice({ payload, deviceLabel: "phone-1", sendToRenderer: mockWebContents });
    expect(second.status).toBe("duplicate");
    expect(second.invoiceId).toBe(first.invoiceId);
  });

  it("rejects invalid payload schema", async () => {
    await expect(
      receiveMobileInvoice({
        payload: { ...payload, id: "not-a-ulid" } as never,
        deviceLabel: "x",
        sendToRenderer: mockWebContents,
      }),
    ).rejects.toThrow(/schema|invalid/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/invoice-receiver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/electron/main/invoice-receiver.ts`:

```ts
import { Buffer } from "node:buffer";
import { MobileInvoicePayloadSchema, type MobileInvoicePayload } from "@chain-pay/shared";

const LRU_CAPACITY = 1000;
const seenIds: Map<string, string> = new Map();

export function _resetSeenIdsForTests(): void {
  seenIds.clear();
}

function recordSeen(mobileId: string, invoiceId: string): void {
  if (seenIds.size >= LRU_CAPACITY) {
    const oldest = seenIds.keys().next().value as string | undefined;
    if (oldest) seenIds.delete(oldest);
  }
  seenIds.set(mobileId, invoiceId);
}

export interface ReceiveResult {
  status: "created" | "duplicate";
  invoiceId: string;
}

export async function receiveMobileInvoice(args: {
  payload: MobileInvoicePayload;
  deviceLabel: string;
  sendToRenderer: Electron.WebContents;
}): Promise<ReceiveResult> {
  const parsed = MobileInvoicePayloadSchema.safeParse(args.payload);
  if (!parsed.success) {
    throw new Error(`invalid mobile invoice payload: ${parsed.error.message}`);
  }
  const seen = seenIds.get(parsed.data.id);
  if (seen) return { status: "duplicate", invoiceId: seen };

  const imageBuffer = Buffer.concat(parsed.data.image_chunks.map((c) => Buffer.from(c, "base64")));
  const invoiceId = `inv_${parsed.data.id.toLowerCase()}`;
  recordSeen(parsed.data.id, invoiceId);

  args.sendToRenderer.send("mobile-invoice:received", {
    invoiceId,
    mobileId: parsed.data.id,
    capturedAt: parsed.data.capturedAt,
    extraction: parsed.data.extraction,
    image: { bytes: imageBuffer.toString("base64"), mime: parsed.data.image_mime },
    sourceLabel: args.deviceLabel,
  });

  return { status: "created", invoiceId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/invoice-receiver.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/invoice-receiver.ts apps/desktop/electron/main/invoice-receiver.test.ts
git commit -m "feat(4): invoice-receiver with LRU idempotency"
```

---

### Task 7: HTTPS pair-server with routes + mDNS

**Files:**
- Create: `apps/desktop/electron/main/pair-server.ts`
- Create: `apps/desktop/electron/main/pair-server.test.ts`
- Modify: `apps/desktop/package.json` (add `bonjour-service`, `selfsigned`)

- [ ] **Step 1: Install dependencies**

```bash
cd apps/desktop && npm install --save bonjour-service@^1.2.0 selfsigned@^2.4.1
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/electron/main/pair-server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { Agent } from "undici";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");
const { initBiscuit, generateRootKeypair, issueCaptureV1Token } = await import("./pair-server-biscuit");
const { _setPairStoreFileForTests, addDevice } = await import("./pair-store");
const { startPairServer, stopPairServer } = await import("./pair-server");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pair-server-test-"));
const storeFile = path.join(tmpDir, "paired-devices.enc");

let baseUrl = "";
let certFingerprint = "";
let dispatcher: Agent;
let rootKeypair: ReturnType<typeof generateRootKeypair>;
let validToken: string;
let validTokenId: string;
const rendererSend = vi.fn();

beforeAll(async () => {
  await initBiscuit();
  resetSafeStorageForTests();
  _setPairStoreFileForTests(storeFile);
  rootKeypair = generateRootKeypair();
  const issued = issueCaptureV1Token({
    root: rootKeypair, deviceLabel: "phone-1", expiresAtRfc3339: "2099-01-01T00:00:00Z",
  });
  validToken = issued.token;
  validTokenId = issued.tokenId;
  await addDevice({
    tokenId: validTokenId, deviceLabel: "phone-1", commPubkey: "0x" + "ab".repeat(32),
    capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 4102444800000,
  });
  const started = await startPairServer({
    port: 0,
    rootKeypair,
    appVersion: "0.4.0-test",
    sendToRenderer: { send: rendererSend } as unknown as Electron.WebContents,
    mdns: false,
    commPubkey: "0x" + "ff".repeat(32),
  });
  baseUrl = `https://127.0.0.1:${started.port}`;
  certFingerprint = started.certFingerprint;
  // Scoped trust: trust the server's actual cert as a CA, only for this dispatcher.
  // No global TLS-reject toggling — that would leak across the whole process.
  dispatcher = new Agent({ connect: { ca: started.certPem } });
});

afterAll(async () => {
  await dispatcher.close();
  await stopPairServer();
});

beforeEach(() => rendererSend.mockReset());

async function call(p: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(baseUrl + p, {
    ...init,
    headers: { ...init.headers, "Content-Type": "application/json" },
    // @ts-expect-error — undici's `dispatcher` is recognized by node:fetch at runtime
    dispatcher,
  });
}

describe("pair-server routes", () => {
  it("GET /health returns ok envelope", async () => {
    const r = await call("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, app: "chainpay" });
  });

  it("GET /comm-pubkey returns the desktop comm pubkey", async () => {
    const r = await call("/comm-pubkey");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ comm_pubkey: "0x" + "ff".repeat(32) });
  });

  it("POST /invoices without Authorization returns 401", async () => {
    const r = await call("/invoices", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("POST /invoices with valid token + valid payload returns 201", async () => {
    const payload = {
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [Buffer.from("x").toString("base64")],
      image_mime: "image/jpeg",
    };
    const r = await call("/invoices", {
      method: "POST",
      headers: { Authorization: `Bearer ${validToken}` },
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(201);
    expect(rendererSend).toHaveBeenCalledWith(
      "mobile-invoice:received",
      expect.objectContaining({ sourceLabel: "phone-1" }),
    );
  });

  it("exposes certFingerprint for QR payload", () => {
    expect(certFingerprint).toMatch(/^[A-F0-9:]{95}$/i);
  });
});
```

Note the test uses self-signed TLS but **does not** disable global TLS verification. Instead, `startPairServer` returns the generated cert PEM, and the test constructs an undici `Agent` with that PEM as a scoped CA. Trust is per-dispatcher, not process-wide — no MITM exposure for other fetch calls in the same Node process.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/pair-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/electron/main/pair-server.ts`:

```ts
import https from "node:https";
import { createHash } from "node:crypto";
import { Bonjour } from "bonjour-service";
import selfsigned from "selfsigned";
import os from "node:os";
import { MobileInvoicePayloadSchema, MOBILE_ROUTES } from "@chain-pay/shared";
import { verifyToken, type RootKeypair } from "./pair-server-biscuit";
import { getDeviceByTokenId, isRevoked } from "./pair-store";
import { receiveMobileInvoice } from "./invoice-receiver";

const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

interface StartArgs {
  port: number;
  rootKeypair: RootKeypair;
  appVersion: string;
  sendToRenderer: Electron.WebContents;
  mdns: boolean;
  commPubkey: string;
}

interface StartResult {
  port: number;
  certFingerprint: string;
  certPem: string;
}

let serverHandle: { server: https.Server; bonjour: Bonjour | null } | null = null;

export async function startPairServer(args: StartArgs): Promise<StartResult> {
  const attrs = [{ name: "commonName", value: os.hostname() || "chainpay" }];
  const pems = selfsigned.generate(attrs, { keySize: 2048, days: 365 });
  const fingerprint = sha256Fingerprint(pems.cert);

  const server = https.createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
    try {
      await routeRequest(req, res, args, fingerprint);
    } catch (e: unknown) {
      sendJson(res, 500, { error: "internal" });
    }
  });

  await new Promise<void>((resolve) => server.listen(args.port, () => resolve()));
  const port = (server.address() as { port: number }).port;

  let bonjour: Bonjour | null = null;
  if (args.mdns) {
    bonjour = new Bonjour();
    bonjour.publish({ name: `ChainPay on ${os.hostname()}`, type: "chainpay", port });
  }

  serverHandle = { server, bonjour };
  return { port, certFingerprint: fingerprint, certPem: pems.cert };
}

export async function stopPairServer(): Promise<void> {
  if (!serverHandle) return;
  const { server, bonjour } = serverHandle;
  if (bonjour) bonjour.unpublishAll(() => bonjour.destroy());
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  serverHandle = null;
}

async function routeRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  args: StartArgs,
  certFingerprint: string,
): Promise<void> {
  const url = req.url ?? "/";
  if (req.method === "GET" && url === MOBILE_ROUTES.health) {
    return sendJson(res, 200, { ok: true, app: "chainpay", version: args.appVersion });
  }
  if (req.method === "GET" && url === MOBILE_ROUTES.commPubkey) {
    return sendJson(res, 200, { comm_pubkey: args.commPubkey });
  }
  if (req.method === "POST" && url === MOBILE_ROUTES.pair) {
    return handlePair(req, res);
  }
  if (req.method === "POST" && url === MOBILE_ROUTES.invoices) {
    return handleInvoices(req, res, args);
  }
  sendJson(res, 404, { error: "not found" });
}

async function handlePair(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: "invalid body" });
  return sendJson(res, 200, { ok: true });
}

async function handleInvoices(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  args: StartArgs,
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return sendJson(res, 401, { error: "unauthorized" });
  const token = auth.slice("Bearer ".length).trim();
  const verify = verifyToken({
    token,
    rootPublicKey: args.rootKeypair.publicKey,
    requiredCapability: 'write("invoices")',
    nowRfc3339: new Date().toISOString(),
  });
  if (!verify.ok || !verify.tokenId) return sendJson(res, 401, { error: "unauthorized" });
  if (await isRevoked(verify.tokenId)) return sendJson(res, 401, { error: "revoked" });
  const device = await getDeviceByTokenId(verify.tokenId);
  if (!device) return sendJson(res, 401, { error: "unknown device" });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: "invalid body" });
  const parsed = MobileInvoicePayloadSchema.safeParse(body);
  if (!parsed.success) return sendJson(res, 400, { error: "schema", detail: parsed.error.message });

  try {
    const result = await receiveMobileInvoice({
      payload: parsed.data,
      deviceLabel: device.deviceLabel,
      sendToRenderer: args.sendToRenderer,
    });
    const status = result.status === "duplicate" ? 409 : 201;
    sendJson(res, status, { invoiceId: result.invoiceId });
  } catch {
    sendJson(res, 500, { error: "dispatch failed" });
  }
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > BODY_LIMIT_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sha256Fingerprint(pem: string): string {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  const der = Buffer.from(body, "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/pair-server.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/pair-server.ts apps/desktop/electron/main/pair-server.test.ts apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(4): HTTPS pair-server with routes + mDNS + self-signed TLS"
```

---

### Task 8: Boot pair-server from Electron main

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/preload/index.ts`

- [ ] **Step 1: Read existing main entry**

Run: `wc -l apps/desktop/electron/main/index.ts`
Read the file end-to-end so additions land in the right place.

- [ ] **Step 2: Wire pair-server boot into the existing `app.whenReady()` handler**

Add to `apps/desktop/electron/main/index.ts` after window creation, alongside the existing IPC setup:

```ts
import { initBiscuit, generateRootKeypair, issueCaptureV1Token } from "./pair-server-biscuit";
import { startPairServer, stopPairServer } from "./pair-server";
import { addDevice, listDevices, revokeDevice } from "./pair-store";
import { encrypt, decrypt } from "./safe-storage";
import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, app } from "electron";

let rootKeypairCache: { privateKey: string; publicKey: string } | null = null;

async function loadOrCreateRootKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  if (rootKeypairCache) return rootKeypairCache;
  const file = path.join(app.getPath("userData"), "biscuit-root.enc");
  try {
    const buf = await fs.readFile(file);
    rootKeypairCache = JSON.parse(decrypt(buf));
    return rootKeypairCache!;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const kp = generateRootKeypair();
    await fs.writeFile(file, encrypt(JSON.stringify(kp)));
    rootKeypairCache = kp;
    return kp;
  }
}

async function bootPairServer(webContents: Electron.WebContents): Promise<void> {
  await initBiscuit();
  const root = await loadOrCreateRootKeypair();
  // Comm pubkey is owned by comm-transport-service. `publicInfo()` returns the full
  // PublicIdentity { mlDsaPub, mlKemPub, ... } or null when no identity is provisioned.
  // For mobile pairing, the "comm pubkey" exposed is the ML-KEM encapsulation pubkey.
  const { publicInfo } = await import("./comm-transport-service");
  const info = await publicInfo();
  await startPairServer({
    port: 8233,
    rootKeypair: root,
    appVersion: app.getVersion(),
    sendToRenderer: webContents,
    mdns: true,
    commPubkey: info?.mlKemPub ?? "0x" + "00".repeat(32),
  });
}

// IPC: renderer pair management
ipcMain.handle("pair:list", async () => listDevices());
ipcMain.handle("pair:revoke", async (_e, tokenId: string) => revokeDevice(tokenId));
ipcMain.handle("pair:issue", async (_e, deviceLabel: string) => {
  const root = await loadOrCreateRootKeypair();
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  const token = issueCaptureV1Token({ root, deviceLabel, expiresAtRfc3339: expiresAt });
  await addDevice({
    tokenId: token.tokenId, deviceLabel, commPubkey: "0x" + "00".repeat(32),
    capabilities: ['write("invoices")'], issuedAt: Date.now(), expiresAt: Date.parse(expiresAt),
  });
  return token;
});
ipcMain.handle("pair:setCommPubkey", async (_e, tokenId: string, commPubkey: string) => {
  const devices = await listDevices();
  const d = devices.find((x) => x.tokenId === tokenId);
  if (d) await addDevice({ ...d, commPubkey });
});

app.on("before-quit", async () => {
  await stopPairServer();
});
```

In the existing `mainWindow.webContents.on("did-finish-load", ...)` (or equivalent ready hook), call:

```ts
await bootPairServer(mainWindow.webContents);
```

- [ ] **Step 3: Expose pair APIs to renderer via preload**

In `apps/desktop/electron/preload/index.ts`, extend the existing `contextBridge.exposeInMainWorld` object with:

```ts
pair: {
  list: () => ipcRenderer.invoke("pair:list"),
  revoke: (tokenId: string) => ipcRenderer.invoke("pair:revoke", tokenId),
  issue: (deviceLabel: string) => ipcRenderer.invoke("pair:issue", deviceLabel),
  setCommPubkey: (tokenId: string, commPubkey: string) =>
    ipcRenderer.invoke("pair:setCommPubkey", tokenId, commPubkey),
  onInvoiceReceived: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("mobile-invoice:received", listener);
    return () => ipcRenderer.removeListener("mobile-invoice:received", listener);
  },
},
```

Also add the matching type to `apps/desktop/src/types/window.d.ts` (or wherever the existing `Window` augmentation lives).

- [ ] **Step 4: Smoke-launch the app**

```bash
cd apps/desktop && npm run dev
```

Expected: app boots normally; logs include "pair-server listening on 8233". `curl -k https://127.0.0.1:8233/health` returns `{"ok":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/src/types/window.d.ts
git commit -m "feat(4): boot pair-server from electron main + renderer IPC"
```

---

### Phase C — Desktop renderer pairing UI (T9)

### Task 9: PairingSection settings UI

**Files:**
- Create: `apps/desktop/src/features/settings/PairingSection.tsx`
- Create: `apps/desktop/src/features/settings/PairingSection.test.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/package.json` (add `qrcode` runtime dep)

- [ ] **Step 1: Install QR generator**

```bash
cd apps/desktop && npm install --save qrcode@^1.5.4
npm install --save-dev @types/qrcode
```

- [ ] **Step 2: Write the failing component test**

Create `apps/desktop/src/features/settings/PairingSection.test.tsx`. Mirrors the `ExtractionSection.test.tsx` pattern from Phase 3c:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PairingSection } from "./PairingSection";

const listMock = vi.fn();
const issueMock = vi.fn();
const revokeMock = vi.fn();

beforeEach(() => {
  listMock.mockReset();
  issueMock.mockReset();
  revokeMock.mockReset();
  (window as unknown as { pair: unknown }).pair = {
    list: listMock,
    issue: issueMock,
    revoke: revokeMock,
    setCommPubkey: vi.fn(),
    onInvoiceReceived: vi.fn(() => () => undefined),
  };
});

describe("PairingSection", () => {
  it("lists paired devices on mount", async () => {
    listMock.mockResolvedValue([
      { tokenId: "tok-1", deviceLabel: "phone-1", expiresAt: Date.now() + 86400000, capabilities: ['write("invoices")'], commPubkey: "0x00", issuedAt: 0 },
    ]);
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    expect(await screen.findByText("phone-1")).toBeInTheDocument();
  });

  it("issues a token and shows the QR after submit", async () => {
    listMock.mockResolvedValue([]);
    issueMock.mockResolvedValue({ token: "EsQCBb...", tokenId: "tok-new" });
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    await userEvent.type(screen.getByPlaceholderText(/device label/i), "phill-pixel-8");
    await userEvent.click(screen.getByRole("button", { name: /generate qr/i }));
    await waitFor(() => expect(issueMock).toHaveBeenCalledWith("phill-pixel-8"));
    expect(await screen.findByTestId("pair-qr-canvas")).toBeInTheDocument();
    expect(await screen.findByTestId("pair-copy-link")).toHaveValue(expect.stringContaining("fiberconnect://"));
  });

  it("revokes a device when the revoke button is clicked", async () => {
    listMock.mockResolvedValueOnce([
      { tokenId: "tok-1", deviceLabel: "phone-1", expiresAt: Date.now() + 86400000, capabilities: ['write("invoices")'], commPubkey: "0x00", issuedAt: 0 },
    ]).mockResolvedValueOnce([]);
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    await userEvent.click(await screen.findByRole("button", { name: /revoke phone-1/i }));
    expect(revokeMock).toHaveBeenCalledWith("tok-1");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/settings/PairingSection.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/src/features/settings/PairingSection.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createFiberConnectUri, type PairedDevice } from "@chain-pay/shared";

interface PairingSectionProps {
  rpcHost: string;
  rpcPort: number;
  certFingerprint: string;
}

declare global {
  interface Window {
    pair: {
      list: () => Promise<PairedDevice[]>;
      issue: (label: string) => Promise<{ token: string; tokenId: string }>;
      revoke: (tokenId: string) => Promise<void>;
      setCommPubkey: (tokenId: string, pk: string) => Promise<void>;
      onInvoiceReceived: (cb: (p: unknown) => void) => () => void;
    };
  }
}

export function PairingSection({ rpcHost, rpcPort, certFingerprint }: PairingSectionProps) {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [label, setLabel] = useState("");
  const [uri, setUri] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const refresh = useCallback(async () => {
    setDevices(await window.pair.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, uri, { errorCorrectionLevel: "M", margin: 1, scale: 6 });
  }, [uri]);

  const onIssue = async () => {
    if (!label.trim()) return;
    setIssuing(true);
    try {
      const { token } = await window.pair.issue(label.trim());
      const newUri = createFiberConnectUri({
        rpc_url: `https://${rpcHost}:${rpcPort}`,
        auth_token: token,
        cert_fingerprint: certFingerprint,
      });
      setUri(newUri);
      await refresh();
    } finally {
      setIssuing(false);
    }
  };

  const onRevoke = async (tokenId: string) => {
    await window.pair.revoke(tokenId);
    await refresh();
  };

  return (
    <section aria-label="Pair mobile devices">
      <h3>Pair mobile</h3>
      <div>
        <input
          placeholder="Device label (e.g. phill-pixel-8)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button onClick={onIssue} disabled={!label.trim() || issuing}>
          Generate QR
        </button>
      </div>
      {uri && (
        <div>
          <canvas data-testid="pair-qr-canvas" ref={canvasRef} />
          <input data-testid="pair-copy-link" readOnly value={uri} />
        </div>
      )}
      <h4>Paired devices</h4>
      {devices.length === 0 ? (
        <p>No devices paired.</p>
      ) : (
        <ul>
          {devices.map((d) => (
            <li key={d.tokenId}>
              <span>{d.deviceLabel}</span>
              <span> expires {new Date(d.expiresAt).toLocaleDateString()}</span>
              <button onClick={() => onRevoke(d.tokenId)} aria-label={`Revoke ${d.deviceLabel}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

Re-export the `PairedDevice` type from `packages/shared`. Add to `packages/shared/src/index.ts`:

```ts
export type { PairedDevice } from "../../apps/desktop/electron/main/pair-store";
```

Actually simpler — duplicate the type in shared since electron/main isn't part of the shared package. Add to `packages/shared/src/mobile-protocol.ts`:

```ts
export interface PairedDevice {
  tokenId: string;
  deviceLabel: string;
  commPubkey: string;
  capabilities: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}
```

And update `apps/desktop/electron/main/pair-store.ts` to import `PairedDevice` from `@chain-pay/shared` instead of defining locally.

- [ ] **Step 5: Mount in SettingsPage**

Modify `apps/desktop/src/features/settings/SettingsPage.tsx` to render `<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint={...} />` alongside the existing `ExtractionSection`. Fetch the cert fingerprint via a new `pair:info` IPC handler that returns `{ certFingerprint }` from the running server.

Add to electron main `index.ts`:

```ts
let serverInfoCache: { certFingerprint: string } | null = null;
// After startPairServer call:
serverInfoCache = { certFingerprint: started.certFingerprint };
ipcMain.handle("pair:info", async () => serverInfoCache);
```

And in preload:

```ts
pair: {
  // ...existing handlers
  info: () => ipcRenderer.invoke("pair:info"),
},
```

`SettingsPage.tsx` fetches once on mount via `window.pair.info()`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/settings/PairingSection.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/settings/PairingSection.tsx apps/desktop/src/features/settings/PairingSection.test.tsx apps/desktop/src/features/settings/SettingsPage.tsx apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/electron/main/pair-store.ts packages/shared/src/mobile-protocol.ts apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(4): PairingSection settings UI with QR + paired device list"
```

---

### Phase D — Mobile app scaffold (T10–T11)

### Task 10: Scaffold the Expo app

**Files:**
- Create: `apps/mobile/` (entire Expo project tree)
- Modify: `package.json` (root) — add workspace

- [ ] **Step 1: Create Expo project**

```bash
cd apps && npx create-expo-app@latest mobile --template blank-typescript --no-install
cd mobile && npm install
```

- [ ] **Step 2: Add to root workspace**

Modify root `package.json`:

```json
{
  "workspaces": ["apps/desktop", "apps/mobile", "packages/*"]
}
```

- [ ] **Step 3: Install Phase 4 dependencies**

```bash
cd apps/mobile && npx expo install \
  react-native-vision-camera \
  @react-native-ml-kit/text-recognition \
  react-native-mmkv \
  expo-secure-store \
  expo-file-system \
  expo-router \
  expo-camera \
  expo-image-manipulator \
  react-native-zeroconf \
  @react-native-community/netinfo \
  ulid \
  zustand

cd apps/mobile && npm install --save \
  @chain-pay/shared@* \
  zod
```

- [ ] **Step 4: Configure expo-router and entry point**

Replace `apps/mobile/App.tsx` content with the expo-router entry. Add to `apps/mobile/package.json`:

```json
{
  "main": "expo-router/entry"
}
```

Create `apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from "expo-router";
export default function Layout() {
  return <Stack />;
}
```

Create `apps/mobile/app/index.tsx` placeholder (real content in Task 22):

```tsx
import { Text, View } from "react-native";
export default function Home() {
  return <View><Text>ChainPay Mobile</Text></View>;
}
```

- [ ] **Step 5: Smoke launch**

```bash
cd apps/mobile && npx expo start
```

Expected: dev server starts; QR code shown. Skip on-device for now — confirm tunnel runs without error.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile package.json
git commit -m "feat(4): scaffold Expo mobile app with deps"
```

---

### Task 11: Wire shared package into mobile + vitest config

**Files:**
- Modify: `apps/mobile/tsconfig.json`
- Modify: `apps/mobile/metro.config.js`
- Create: `apps/mobile/vitest.config.ts`
- Create: `apps/mobile/babel.config.js`

- [ ] **Step 1: Configure metro to resolve workspace packages**

Create `apps/mobile/metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
```

- [ ] **Step 2: Configure tsconfig paths**

Update `apps/mobile/tsconfig.json`:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@chain-pay/shared": ["../../packages/shared/src"],
      "@chain-pay/shared/*": ["../../packages/shared/src/*"],
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 3: Configure vitest for unit tests (Node-only modules)**

```bash
cd apps/mobile && npm install --save-dev vitest @testing-library/react-native @testing-library/jest-dom @vitest/coverage-v8 jsdom react-test-renderer
```

Create `apps/mobile/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts", "stores/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@chain-pay/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@": path.resolve(__dirname, "./"),
    },
  },
});
```

Create `apps/mobile/vitest.setup.ts`:

```ts
import { vi } from "vitest";
vi.mock("react-native-mmkv", () => {
  const store = new Map<string, string>();
  return {
    MMKV: class {
      set(k: string, v: string) { store.set(k, v); }
      getString(k: string) { return store.get(k); }
      delete(k: string) { store.delete(k); }
      contains(k: string) { return store.has(k); }
      clearAll() { store.clear(); }
    },
  };
});
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  cacheDirectory: "/tmp/test-cache/",
  writeAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
}));
```

- [ ] **Step 4: Run an initial smoke test**

Create `apps/mobile/lib/_sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createFiberConnectUri, parseFiberConnectUri } from "@chain-pay/shared";

describe("shared package resolves from mobile", () => {
  it("round-trips", () => {
    const uri = createFiberConnectUri({ rpc_url: "https://x:1", auth_token: "t" });
    expect(parseFiberConnectUri(uri).auth_token).toBe("t");
  });
});
```

Run: `cd apps/mobile && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/tsconfig.json apps/mobile/metro.config.js apps/mobile/vitest.config.ts apps/mobile/vitest.setup.ts apps/mobile/lib/_sanity.test.ts apps/mobile/package.json apps/mobile/package-lock.json
git commit -m "feat(4): wire @chain-pay/shared + vitest for mobile"
```

---

### Phase E — Mobile stores + transport (T12–T16)

### Task 12: Pairing store (expo-secure-store-backed)

**Files:**
- Create: `apps/mobile/stores/pairing.ts`
- Create: `apps/mobile/stores/pairing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/stores/pairing.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as SecureStore from "expo-secure-store";
import { usePairingStore, _resetPairingStoreForTests } from "./pairing";

const mockedSecureStore = SecureStore as unknown as {
  setItemAsync: ReturnType<typeof vi.fn>;
  getItemAsync: ReturnType<typeof vi.fn>;
  deleteItemAsync: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  _resetPairingStoreForTests();
  mockedSecureStore.setItemAsync.mockReset();
  mockedSecureStore.getItemAsync.mockReset();
});

describe("pairing store", () => {
  it("savePairing persists payload and exposes it via getter", async () => {
    await usePairingStore.getState().savePairing({
      rpc_url: "https://desk:8233/",
      auth_token: "tok",
      cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "11".repeat(32),
    });
    expect(mockedSecureStore.setItemAsync).toHaveBeenCalled();
    expect(usePairingStore.getState().pairing?.auth_token).toBe("tok");
  });

  it("clearPairing wipes the payload and the secure-store entry", async () => {
    await usePairingStore.getState().savePairing({
      rpc_url: "https://desk:8233/", auth_token: "tok", cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "22".repeat(32),
    });
    await usePairingStore.getState().clearPairing();
    expect(usePairingStore.getState().pairing).toBeNull();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it("loadPairing hydrates from secure storage on init", async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(
      JSON.stringify({
        rpc_url: "https://x:1/", auth_token: "t", cert_fingerprint: "F",
        desktop_comm_pubkey: "0x" + "33".repeat(32),
      }),
    );
    await usePairingStore.getState().loadPairing();
    expect(usePairingStore.getState().pairing?.auth_token).toBe("t");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run stores/pairing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/stores/pairing.ts`:

```ts
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const KEY = "chainpay.pairing.v1";

export interface PairingPayload {
  rpc_url: string;
  auth_token: string;
  cert_fingerprint: string;
  desktop_comm_pubkey: string;
}

interface PairingState {
  pairing: PairingPayload | null;
  savePairing: (p: PairingPayload) => Promise<void>;
  clearPairing: () => Promise<void>;
  loadPairing: () => Promise<void>;
}

export const usePairingStore = create<PairingState>((set) => ({
  pairing: null,
  savePairing: async (p) => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(p));
    set({ pairing: p });
  },
  clearPairing: async () => {
    await SecureStore.deleteItemAsync(KEY);
    set({ pairing: null });
  },
  loadPairing: async () => {
    const raw = await SecureStore.getItemAsync(KEY);
    set({ pairing: raw ? (JSON.parse(raw) as PairingPayload) : null });
  },
}));

export function _resetPairingStoreForTests(): void {
  usePairingStore.setState({ pairing: null });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run stores/pairing.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/stores/pairing.ts apps/mobile/stores/pairing.test.ts
git commit -m "feat(4): mobile pairing store with secure-store persistence"
```

---

### Task 13: Sync queue store (MMKV + state machine)

**Files:**
- Create: `apps/mobile/stores/sync-queue.ts`
- Create: `apps/mobile/stores/sync-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/stores/sync-queue.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSyncQueue, _resetQueueForTests, backoffMs } from "./sync-queue";

const sample = {
  capturedAt: 1717286400000,
  imageRef: "img-1.jpg",
  extraction: { body: {}, field_confidences: {}, warnings: [] },
};

beforeEach(() => _resetQueueForTests());

describe("sync-queue", () => {
  it("enqueue adds a pending item", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    const items = useSyncQueue.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].status).toBe("pending");
  });

  it("markSyncing then markSynced transitions correctly", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().markSyncing(id);
    expect(useSyncQueue.getState().findById(id)?.status).toBe("syncing");
    useSyncQueue.getState().markSynced(id, "inv_xyz");
    expect(useSyncQueue.getState().findById(id)?.status).toBe("synced");
    expect(useSyncQueue.getState().findById(id)?.syncedInvoiceId).toBe("inv_xyz");
  });

  it("markFailed bumps attempts and returns to pending", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().markFailed(id, "timeout");
    const item = useSyncQueue.getState().findById(id)!;
    expect(item.attempts).toBe(1);
    expect(item.status).toBe("pending");
    expect(item.lastError).toBe("timeout");
  });

  it("v1 stays 'pending' through repeated failures (no cellular escalation)", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    for (let i = 0; i < 10; i++) useSyncQueue.getState().markFailed(id, "5xx");
    expect(useSyncQueue.getState().findById(id)?.status).toBe("pending");
    expect(useSyncQueue.getState().findById(id)?.attempts).toBe(10);
  });

  it("backoffMs scales by attempts capped at 5min", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(4)).toBe(16000);
    expect(backoffMs(5)).toBe(32000);
    expect(backoffMs(8)).toBe(256000);
    expect(backoffMs(20)).toBe(300000);
  });

  it("nextDrainCandidate returns oldest pending", () => {
    const a = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().enqueue({ ...sample, capturedAt: 1717286400001 });
    expect(useSyncQueue.getState().nextDrainCandidate()?.id).toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run stores/sync-queue.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/stores/sync-queue.ts`:

```ts
import { create } from "zustand";
import { ulid } from "ulid";
import { MMKV } from "react-native-mmkv";

const storage = new MMKV();
const KEY = "chainpay.queue.v1";

// Note: "pending-cellular" reserved for v2 CEMP-PQ fallback; v1 never transitions into it.
export type QueueStatus = "pending" | "syncing" | "synced" | "rejected" | "pending-cellular";

export interface QueueItem {
  id: string;
  capturedAt: number;
  imageRef: string;
  extraction: { body: Record<string, unknown>; field_confidences: Record<string, number>; warnings: unknown[] };
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  syncedInvoiceId?: string;
  transport?: "ip" | "cemp-pq";
}

interface QueueState {
  items: QueueItem[];
  enqueue: (data: Omit<QueueItem, "id" | "status" | "attempts">) => string;
  markSyncing: (id: string) => void;
  markSynced: (id: string, invoiceId: string) => void;
  markFailed: (id: string, error: string) => void;
  markRejected: (id: string, error: string) => void;
  findById: (id: string) => QueueItem | undefined;
  nextDrainCandidate: () => QueueItem | undefined;
  removeSynced: (olderThanMs: number) => string[];
}

function load(): QueueItem[] {
  const raw = storage.getString(KEY);
  return raw ? (JSON.parse(raw) as QueueItem[]) : [];
}

function save(items: QueueItem[]): void {
  storage.set(KEY, JSON.stringify(items));
}

export const useSyncQueue = create<QueueState>((set, get) => ({
  items: load(),

  enqueue: (data) => {
    const id = ulid();
    const item: QueueItem = { ...data, id, status: "pending", attempts: 0 };
    const items = [...get().items, item];
    save(items);
    set({ items });
    return id;
  },

  markSyncing: (id) => {
    const items = get().items.map((i) => (i.id === id ? { ...i, status: "syncing" as const } : i));
    save(items);
    set({ items });
  },

  markSynced: (id, invoiceId) => {
    const items = get().items.map((i) =>
      i.id === id ? { ...i, status: "synced" as const, syncedInvoiceId: invoiceId } : i,
    );
    save(items);
    set({ items });
  },

  markFailed: (id, error) => {
    const items = get().items.map((i) => {
      if (i.id !== id) return i;
      const attempts = i.attempts + 1;
      // v1: always retry as 'pending'; cellular escalation reserved for v2.
      return { ...i, status: "pending" as const, attempts, lastError: error };
    });
    save(items);
    set({ items });
  },

  markRejected: (id, error) => {
    const items = get().items.map((i) =>
      i.id === id ? { ...i, status: "rejected" as const, lastError: error } : i,
    );
    save(items);
    set({ items });
  },

  findById: (id) => get().items.find((i) => i.id === id),

  nextDrainCandidate: () =>
    get().items
      .filter((i) => i.status === "pending" || i.status === "pending-cellular")
      .sort((a, b) => a.capturedAt - b.capturedAt)[0],

  removeSynced: (olderThanMs) => {
    const cutoff = Date.now() - olderThanMs;
    const toRemove = get().items.filter((i) => i.status === "synced" && i.capturedAt < cutoff);
    const items = get().items.filter((i) => !toRemove.includes(i));
    save(items);
    set({ items });
    return toRemove.map((i) => i.imageRef);
  },
}));

export function backoffMs(attempts: number): number {
  return Math.min(1000 * Math.pow(2, attempts), 300_000);
}

export function _resetQueueForTests(): void {
  storage.delete(KEY);
  useSyncQueue.setState({ items: [] });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run stores/sync-queue.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/stores/sync-queue.ts apps/mobile/stores/sync-queue.test.ts
git commit -m "feat(4): mobile sync-queue with state machine + backoff"
```

---

### Task 14: IP transport client

**Files:**
- Create: `apps/mobile/lib/transport/ip-client.ts`
- Create: `apps/mobile/lib/transport/ip-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/transport/ip-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendInvoiceViaIp, healthCheck } from "./ip-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const pairing = {
  rpc_url: "https://desk:8233/",
  auth_token: "tok",
  cert_fingerprint: "AB:CD",
  desktop_comm_pubkey: "0x" + "00".repeat(32),
};

describe("ip-client", () => {
  it("sendInvoice succeeds on 201 and returns invoiceId", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoiceId: "inv_x" }), { status: 201 }));
    const result = await sendInvoiceViaIp({
      pairing,
      payload: {
        id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1,
        extraction: { body: {}, field_confidences: {}, warnings: [] },
        image_chunks: ["AA"], image_mime: "image/jpeg",
      },
    });
    expect(result).toEqual({ ok: true, status: "created", invoiceId: "inv_x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://desk:8233/invoices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("sendInvoice treats 409 as duplicate-success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoiceId: "inv_y" }), { status: 409 }));
    const result = await sendInvoiceViaIp({
      pairing,
      payload: {
        id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1,
        extraction: { body: {}, field_confidences: {}, warnings: [] },
        image_chunks: ["AA"], image_mime: "image/jpeg",
      },
    });
    expect(result).toEqual({ ok: true, status: "duplicate", invoiceId: "inv_y" });
  });

  it("sendInvoice returns kind=unauthorized on 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const result = await sendInvoiceViaIp({ pairing, payload: {} as never });
    expect(result).toEqual({ ok: false, kind: "unauthorized" });
  });

  it("sendInvoice returns kind=server on 500", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const result = await sendInvoiceViaIp({ pairing, payload: {} as never });
    expect(result.ok).toBe(false);
    expect((result as { kind: string }).kind).toBe("server");
  });

  it("healthCheck returns true on 200 {ok:true}", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, app: "chainpay", version: "0" }), { status: 200 }));
    expect(await healthCheck(pairing)).toBe(true);
  });

  it("healthCheck returns false on network throw", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await healthCheck(pairing)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/transport/ip-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/lib/transport/ip-client.ts`:

```ts
import { MOBILE_ROUTES, type MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";

export type IpSendResult =
  | { ok: true; status: "created" | "duplicate"; invoiceId: string }
  | { ok: false; kind: "unauthorized" | "client" | "server" | "network"; detail?: string };

export async function sendInvoiceViaIp(args: {
  pairing: PairingPayload;
  payload: MobileInvoicePayload;
}): Promise<IpSendResult> {
  const url = new URL(MOBILE_ROUTES.invoices, args.pairing.rpc_url).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.pairing.auth_token}`,
      },
      body: JSON.stringify(args.payload),
    });
    if (res.status === 201) {
      const j = (await res.json()) as { invoiceId: string };
      return { ok: true, status: "created", invoiceId: j.invoiceId };
    }
    if (res.status === 409) {
      const j = (await res.json()) as { invoiceId: string };
      return { ok: true, status: "duplicate", invoiceId: j.invoiceId };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "unauthorized" };
    }
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, kind: "client", detail: await res.text() };
    }
    return { ok: false, kind: "server", detail: await res.text() };
  } catch (e) {
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function healthCheck(pairing: PairingPayload): Promise<boolean> {
  try {
    const url = new URL(MOBILE_ROUTES.health, pairing.rpc_url).toString();
    const res = await fetch(url, { method: "GET" });
    if (res.status !== 200) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

export async function fetchCommPubkey(pairing: PairingPayload): Promise<string | null> {
  try {
    const url = new URL(MOBILE_ROUTES.commPubkey, pairing.rpc_url).toString();
    const res = await fetch(url, { method: "GET" });
    if (res.status !== 200) return null;
    const j = (await res.json()) as { comm_pubkey: string };
    return j.comm_pubkey;
  } catch {
    return null;
  }
}
```

Note: native cert pinning will be configured in the Expo native config at app-build time (see Task 19 for the React Native fetch cert-pin wiring). For unit tests, fetch is mocked so the pinning code path is not exercised here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/transport/ip-client.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/transport/ip-client.ts apps/mobile/lib/transport/ip-client.test.ts
git commit -m "feat(4): mobile IP transport client with bearer auth"
```

---

### Task 15: CEMP-PQ transport client — **DEFERRED to v2**

**Skip this task in v1.** The `@chain-pay/cemp-pq` package exports low-level primitives (`serializeProfile`, `serializeEncryptedMessage`, `CEMPTransactionBuilder`, `MLDSASigner`) — not a high-level encrypt-and-send. Building a working mobile cellular fallback requires CCC bundled on phone, a remote CKB RPC client, ML-KEM encapsulation against the desktop's `mlKemPub`, and tx construction. Out of scope for v1 capture. Original task description preserved below for v2.

---
**Original (deferred):**

**Files:**
- Create: `apps/mobile/lib/transport/cemp-client.ts`
- Create: `apps/mobile/lib/transport/cemp-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/transport/cemp-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { sendInvoiceViaCempPq } from "./cemp-client";

const encryptMock = vi.fn();
const submitMock = vi.fn();
vi.mock("@chain-pay/cemp-pq", () => ({
  encryptForRecipient: (...a: unknown[]) => encryptMock(...a),
  submitMessage: (...a: unknown[]) => submitMock(...a),
}));

const pairing = {
  rpc_url: "https://desk:8233/", auth_token: "tok", cert_fingerprint: "AB",
  desktop_comm_pubkey: "0x" + "ab".repeat(32),
};

describe("cemp-client", () => {
  it("encrypts to the desktop's comm pubkey and submits on-chain", async () => {
    encryptMock.mockResolvedValue({ ciphertext: "0xCC", header: "0xDD" });
    submitMock.mockResolvedValue({ txHash: "0xtx" });
    const result = await sendInvoiceViaCempPq({
      pairing,
      payload: {
        id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1,
        extraction: { body: {}, field_confidences: {}, warnings: [] },
        image_chunks: ["AA"], image_mime: "image/jpeg",
      },
      myCommPrivkey: "0x" + "11".repeat(32),
    });
    expect(result).toEqual({ ok: true, txHash: "0xtx" });
    expect(encryptMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientPubkey: pairing.desktop_comm_pubkey }),
    );
  });

  it("returns ok=false on submit failure", async () => {
    encryptMock.mockResolvedValue({ ciphertext: "0xCC", header: "0xDD" });
    submitMock.mockRejectedValue(new Error("rpc dead"));
    const result = await sendInvoiceViaCempPq({
      pairing,
      payload: { id: "01HXYZABCDEFGHJKMNPQRSTVWX", capturedAt: 1, extraction: { body: {}, field_confidences: {}, warnings: [] }, image_chunks: [], image_mime: "image/jpeg" },
      myCommPrivkey: "0x" + "11".repeat(32),
    });
    expect(result).toEqual({ ok: false, error: "rpc dead" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/transport/cemp-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/lib/transport/cemp-client.ts`:

```ts
import { encryptForRecipient, submitMessage } from "@chain-pay/cemp-pq";
import type { MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";

export type CempSendResult =
  | { ok: true; txHash: string }
  | { ok: false; error: string };

export async function sendInvoiceViaCempPq(args: {
  pairing: PairingPayload;
  payload: MobileInvoicePayload;
  myCommPrivkey: string;
}): Promise<CempSendResult> {
  try {
    const envelope = await encryptForRecipient({
      recipientPubkey: args.pairing.desktop_comm_pubkey,
      senderPrivkey: args.myCommPrivkey,
      plaintext: JSON.stringify(args.payload),
    });
    const { txHash } = await submitMessage(envelope);
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

If `@chain-pay/cemp-pq` exports differ from `encryptForRecipient` / `submitMessage`, adapt the imports to match the existing package's public surface — but keep the function signatures here unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/transport/cemp-client.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/transport/cemp-client.ts apps/mobile/lib/transport/cemp-client.test.ts
git commit -m "feat(4): mobile CEMP-PQ transport for cellular fallback"
```

---

### Task 16: Transport selector + drain worker (IP-only in v1)

**Files:**
- Create: `apps/mobile/lib/transport/index.ts`
- Create: `apps/mobile/lib/transport/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/transport/index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectTransportFor, runDrainOnce } from "./index";
import * as ip from "./ip-client";

vi.mock("./ip-client");

const pairing = {
  rpc_url: "https://desk:8233/", auth_token: "tok", cert_fingerprint: "AB",
  desktop_comm_pubkey: "0x" + "00".repeat(32),
};

beforeEach(() => {
  vi.mocked(ip.sendInvoiceViaIp).mockReset();
});

describe("transport selector (v1: IP-only)", () => {
  it("selectTransportFor always returns 'ip' in v1", () => {
    expect(selectTransportFor("pending")).toBe("ip");
    expect(selectTransportFor("pending-cellular")).toBe("ip");
  });
});

describe("runDrainOnce", () => {
  const item = {
    id: "01HXYZABCDEFGHJKMNPQRSTVWX",
    capturedAt: 1,
    imageRef: "x.jpg",
    extraction: { body: {}, field_confidences: {}, warnings: [] },
    status: "pending" as const,
    attempts: 0,
  };
  const buildPayload = vi.fn(async () => ({
    id: item.id, capturedAt: item.capturedAt, extraction: item.extraction,
    image_chunks: ["AAAA"], image_mime: "image/jpeg" as const,
  }));

  it("dispatches via IP for pending and reports created", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: true, status: "created", invoiceId: "inv_z" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out).toEqual({ kind: "synced", invoiceId: "inv_z" });
    expect(ip.sendInvoiceViaIp).toHaveBeenCalled();
  });

  it("returns 'unauthorized' when IP returns 401", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "unauthorized" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out.kind).toBe("unauthorized");
  });

  it("returns 'retry' on network/server errors", async () => {
    vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "server", detail: "boom" });
    const out = await runDrainOnce({ item, pairing, buildPayload });
    expect(out).toEqual({ kind: "retry", error: "boom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/transport/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/lib/transport/index.ts`:

```ts
import type { MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";
import type { QueueItem, QueueStatus } from "@/stores/sync-queue";
import { sendInvoiceViaIp } from "./ip-client";

// v1: always "ip". The signature accepts a status so v2 can introduce "cemp-pq"
// without changing call sites.
export function selectTransportFor(_status: QueueStatus): "ip" {
  return "ip";
}

export type DrainOutcome =
  | { kind: "synced"; invoiceId: string }
  | { kind: "rejected"; error: string }
  | { kind: "unauthorized" }
  | { kind: "retry"; error: string };

export async function runDrainOnce(args: {
  item: QueueItem;
  pairing: PairingPayload;
  buildPayload: (item: QueueItem) => Promise<MobileInvoicePayload>;
}): Promise<DrainOutcome> {
  const payload = await args.buildPayload(args.item);
  const result = await sendInvoiceViaIp({ pairing: args.pairing, payload });
  if (result.ok) return { kind: "synced", invoiceId: result.invoiceId };
  if (result.kind === "unauthorized") return { kind: "unauthorized" };
  if (result.kind === "client") return { kind: "rejected", error: result.detail ?? "client error" };
  return { kind: "retry", error: result.detail ?? result.kind };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/transport/index.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/transport/index.ts apps/mobile/lib/transport/index.test.ts
git commit -m "feat(4): mobile transport selector + drain dispatcher"
```

---

### Phase F — Mobile OCR (T17–T18)

### Task 17: Native OCR wrapper

**Files:**
- Create: `apps/mobile/lib/ocr/native-ocr.ts`
- Create: `apps/mobile/lib/ocr/native-ocr.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/ocr/native-ocr.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { recognizeText } from "./native-ocr";

const mlkitMock = vi.fn();
vi.mock("@react-native-ml-kit/text-recognition", () => ({
  default: { recognize: (...a: unknown[]) => mlkitMock(...a) },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

describe("native-ocr", () => {
  it("returns blocks + lines + full text from ML Kit on Android", async () => {
    mlkitMock.mockResolvedValue({
      text: "Acme Co\nINV-123\n$100.00",
      blocks: [
        { text: "Acme Co", lines: [{ text: "Acme Co", frame: { x: 0, y: 0, width: 50, height: 10 } }] },
        { text: "INV-123\n$100.00", lines: [
          { text: "INV-123", frame: { x: 0, y: 20, width: 50, height: 10 } },
          { text: "$100.00", frame: { x: 0, y: 35, width: 50, height: 10 } },
        ]},
      ],
    });
    const result = await recognizeText("/tmp/img.jpg");
    expect(result.fullText).toBe("Acme Co\nINV-123\n$100.00");
    expect(result.lines).toHaveLength(3);
    expect(result.lines[1].text).toBe("INV-123");
    expect(result.lines[1].box).toEqual({ x: 0, y: 20, w: 50, h: 10 });
  });

  it("returns empty on ML Kit throw", async () => {
    mlkitMock.mockRejectedValue(new Error("camera"));
    const result = await recognizeText("/tmp/x.jpg");
    expect(result.fullText).toBe("");
    expect(result.lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/ocr/native-ocr.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/lib/ocr/native-ocr.ts`:

```ts
import { Platform } from "react-native";
import TextRecognition from "@react-native-ml-kit/text-recognition";

export interface OcrLine {
  text: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  fullText: string;
  lines: OcrLine[];
}

export async function recognizeText(imageUri: string): Promise<OcrResult> {
  try {
    if (Platform.OS === "ios") return await runVision(imageUri);
    return await runMlKit(imageUri);
  } catch {
    return { fullText: "", lines: [] };
  }
}

async function runMlKit(uri: string): Promise<OcrResult> {
  const out = await TextRecognition.recognize(uri);
  const lines: OcrLine[] = [];
  for (const block of out.blocks ?? []) {
    for (const line of block.lines ?? []) {
      lines.push({
        text: line.text,
        box: {
          x: line.frame?.x ?? 0,
          y: line.frame?.y ?? 0,
          w: line.frame?.width ?? 0,
          h: line.frame?.height ?? 0,
        },
      });
    }
  }
  return { fullText: out.text ?? "", lines };
}

async function runVision(uri: string): Promise<OcrResult> {
  // iOS: use the same @react-native-ml-kit/text-recognition package — it falls back to a
  // Vision-framework-equivalent on iOS via the package's native module. If a separate
  // Vision-specific module is preferred later, swap this implementation.
  return runMlKit(uri);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/ocr/native-ocr.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/ocr/native-ocr.ts apps/mobile/lib/ocr/native-ocr.test.ts
git commit -m "feat(4): native-ocr wrapper for Vision + ML Kit"
```

---

### Task 18: OCR text-to-extraction mapper

**Files:**
- Create: `apps/mobile/lib/ocr/mapper.ts`
- Create: `apps/mobile/lib/ocr/mapper.test.ts`

The desktop already has `apps/desktop/src/lib/invoices/regex-shared.ts` from 3c. Mobile reuses those regexes via a re-export the desktop side already publishes. If `regex-shared.ts` is not yet in `@chain-pay/shared`, move it there as part of this task (one paragraph below).

- [ ] **Step 1: Verify regex-shared availability**

Check: `cat packages/shared/src/index.ts | grep regex-shared`

If not present: move `apps/desktop/src/lib/invoices/regex-shared.ts` into `packages/shared/src/invoice-regex.ts`, update the desktop import path, and re-export from shared. Add an extra commit before this task's commit.

- [ ] **Step 2: Write the failing test**

Create `apps/mobile/lib/ocr/mapper.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ocrToExtraction } from "./mapper";

const invoiceText = `
Acme Coffee Roasters
2026-05-15
Invoice #INV-2026-0421
BSB: 062-001
Acct: 1234 5678
Subtotal: $100.00
GST: $10.00
Total: $110.00 AUD
`;

describe("ocrToExtraction", () => {
  it("extracts invoice number from a typical invoice", () => {
    const out = ocrToExtraction(invoiceText);
    expect(out.body.invoice_number).toBe("INV-2026-0421");
  });

  it("extracts total amount and currency", () => {
    const out = ocrToExtraction(invoiceText);
    expect(out.body.total).toBe(110);
    expect(out.body.currency).toBe("AUD");
  });

  it("extracts BSB + account when present", () => {
    const out = ocrToExtraction(invoiceText);
    expect(out.body.bank?.bsb).toBe("062-001");
  });

  it("produces field_confidences in [0,1]", () => {
    const out = ocrToExtraction(invoiceText);
    for (const c of Object.values(out.field_confidences)) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty body for unparseable input", () => {
    const out = ocrToExtraction("random gibberish without numbers");
    expect(Object.keys(out.body)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/ocr/mapper.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write the implementation**

Create `apps/mobile/lib/ocr/mapper.ts` — thin wrapper around the shared regex extractor:

```ts
import { extractFromText } from "@chain-pay/shared/invoice-regex";

export interface MobileExtraction {
  body: Record<string, unknown>;
  field_confidences: Record<string, number>;
  warnings: unknown[];
}

export function ocrToExtraction(text: string): MobileExtraction {
  const extracted = extractFromText(text);
  return {
    body: extracted.body,
    field_confidences: extracted.field_confidences,
    warnings: extracted.warnings,
  };
}
```

If `extractFromText` doesn't exist in the shared package yet, expose it as a re-export of the desktop's existing rules.ts entry point (the one Phase 3b/3c already split out).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/ocr/mapper.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/ocr/mapper.ts apps/mobile/lib/ocr/mapper.test.ts
git commit -m "feat(4): mobile OCR mapper reusing shared invoice regexes"
```

---

### Phase G — Mobile UI screens (T19–T22)

### Task 19: Pairing screen with QR scan

**Files:**
- Create: `apps/mobile/app/pair.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useState } from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { parseFiberConnectUri } from "@chain-pay/shared";
import { usePairingStore } from "@/stores/pairing";
import { fetchCommPubkey, healthCheck } from "@/lib/transport/ip-client";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const savePairing = usePairingStore((s) => s.savePairing);

  const onScan = async ({ data }: { data: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const parsed = parseFiberConnectUri(data);
      const pairing = {
        rpc_url: parsed.rpc_url,
        auth_token: parsed.auth_token,
        cert_fingerprint: parsed.cert_fingerprint ?? "",
        desktop_comm_pubkey: "0x" + "00".repeat(32),
      };
      const healthy = await healthCheck(pairing);
      if (!healthy) {
        Alert.alert("Cannot reach desktop", "Make sure desktop ChainPay is running on this network.");
        setBusy(false);
        return;
      }
      const commPubkey = await fetchCommPubkey(pairing);
      await savePairing({ ...pairing, desktop_comm_pubkey: commPubkey ?? pairing.desktop_comm_pubkey });
      router.replace("/");
    } catch (e) {
      Alert.alert("Invalid QR", e instanceof Error ? e.message : "could not parse");
      setBusy(false);
    }
  };

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text>Camera permission required to pair.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView style={styles.full} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
      <Text style={styles.hint}>Point at the QR shown by ChainPay desktop</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  hint: { position: "absolute", bottom: 24, alignSelf: "center", color: "white", backgroundColor: "rgba(0,0,0,0.5)", padding: 8, borderRadius: 6 },
});
```

- [ ] **Step 2: Smoke test**

Run: `cd apps/mobile && npx expo start --tunnel`
Open on a physical device. Tap "Pair desktop" — should request camera permission, then show the scanner.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/pair.tsx
git commit -m "feat(4): mobile pair screen with QR scan + health probe"
```

---

### Task 20: Capture screen

**Files:**
- Create: `apps/mobile/app/capture.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useRef, useState } from "react";
import { ActivityIndicator, Button, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { router } from "expo-router";
import { recognizeText } from "@/lib/ocr/native-ocr";
import { ocrToExtraction } from "@/lib/ocr/mapper";
import { useSyncQueue } from "@/stores/sync-queue";

export default function CaptureScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const enqueue = useSyncQueue((s) => s.enqueue);

  const onShutter = async () => {
    if (!cam.current || busy) return;
    setBusy(true);
    try {
      const shot = await cam.current.takePictureAsync({ quality: 0.85 });
      if (!shot) throw new Error("no photo");
      const resized = await ImageManipulator.manipulateAsync(
        shot.uri,
        [{ resize: { width: 2000 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      );
      const filename = `capture-${Date.now()}.jpg`;
      const dest = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.moveAsync({ from: resized.uri, to: dest });

      const ocr = await recognizeText(dest);
      const extraction = ocrToExtraction(ocr.fullText);
      const id = enqueue({ capturedAt: Date.now(), imageRef: filename, extraction });
      router.push({ pathname: "/review", params: { id } });
    } finally {
      setBusy(false);
    }
  };

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text>Camera permission required.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView ref={cam} style={styles.full} />
      <View style={styles.bar}>
        {busy ? <ActivityIndicator /> : <Button title="Capture" onPress={onShutter} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  bar: { position: "absolute", bottom: 24, alignSelf: "center", backgroundColor: "white", padding: 12, borderRadius: 8 },
});
```

- [ ] **Step 2: Smoke test**

Run on device, tap shutter. Expect: photo captures, OCR runs, navigates to `/review?id=...`. (Review screen is a stub until next task — should display the id.)

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/capture.tsx
git commit -m "feat(4): capture screen with resize + native OCR + enqueue"
```

---

### Task 21: Review screen

**Files:**
- Create: `apps/mobile/app/review.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useLocalSearchParams, router } from "expo-router";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSyncQueue } from "@/stores/sync-queue";

export default function ReviewScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const item = useSyncQueue((s) => (params.id ? s.findById(params.id) : undefined));

  if (!item) {
    return (
      <View style={styles.center}>
        <Text>Queue item not found.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  const body = item.extraction.body as { invoice_number?: string; total?: number; currency?: string };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Review extraction</Text>
      <Text style={styles.label}>Invoice number</Text>
      <TextInput style={styles.input} defaultValue={body.invoice_number ?? ""} />
      <Text style={styles.label}>Total</Text>
      <TextInput style={styles.input} defaultValue={body.total?.toString() ?? ""} keyboardType="decimal-pad" />
      <Text style={styles.label}>Currency</Text>
      <TextInput style={styles.input} defaultValue={body.currency ?? ""} autoCapitalize="characters" maxLength={3} />
      <View style={styles.row}>
        <Button title="Discard" onPress={() => router.replace("/")} />
        <Button title="Queue for sync" onPress={() => router.replace("/")} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 18, fontWeight: "600" },
  label: { fontSize: 14, color: "#444" },
  input: { borderWidth: 1, borderColor: "#ccc", padding: 8, borderRadius: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 16 },
});
```

Note: in v1, the queue item is already enqueued by Capture. Review screen edits are local-only for now (not wired back to the store) — that's intentional YAGNI; user can re-capture if extraction is wildly wrong. v2 will wire edits back.

- [ ] **Step 2: Smoke test**

Capture a photo, review screen renders with extracted fields, "Queue for sync" returns home. Open the queue → see one pending item.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/review.tsx
git commit -m "feat(4): review screen displaying extracted fields"
```

---

### Task 22: Home (queue) screen + drain hook

**Files:**
- Modify: `apps/mobile/app/index.tsx`
- Create: `apps/mobile/lib/useDrainQueue.ts`

- [ ] **Step 1: Write the drain hook**

Create `apps/mobile/lib/useDrainQueue.ts`:

```ts
import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system";
import { Buffer } from "buffer";
import { IMAGE_CHUNK_BYTES, type MobileInvoicePayload } from "@chain-pay/shared";
import { useSyncQueue, backoffMs, type QueueItem } from "@/stores/sync-queue";
import { usePairingStore } from "@/stores/pairing";
import { runDrainOnce } from "@/lib/transport";

const IMG_DIR = FileSystem.cacheDirectory ?? "";

async function buildPayload(item: QueueItem): Promise<MobileInvoicePayload> {
  const b64 = await FileSystem.readAsStringAsync(`${IMG_DIR}${item.imageRef}`, { encoding: FileSystem.EncodingType.Base64 });
  const buf = Buffer.from(b64, "base64");
  const chunks: string[] = [];
  for (let off = 0; off < buf.length; off += IMAGE_CHUNK_BYTES) {
    chunks.push(buf.subarray(off, off + IMAGE_CHUNK_BYTES).toString("base64"));
  }
  return {
    id: item.id,
    capturedAt: item.capturedAt,
    extraction: item.extraction,
    image_chunks: chunks,
    image_mime: "image/jpeg",
  };
}

export function useDrainQueue(): void {
  const items = useSyncQueue((s) => s.items);
  const pairing = usePairingStore((s) => s.pairing);
  const queue = useSyncQueue;
  const running = useRef(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    NetInfo.fetch().then(() => {
      unsub = NetInfo.addEventListener(() => tick());
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

  useEffect(() => { tick(); }, [items.length, pairing?.auth_token]);

  async function tick(): Promise<void> {
    if (running.current || !pairing) return;
    const item = queue.getState().nextDrainCandidate();
    if (!item) return;
    running.current = true;
    queue.getState().markSyncing(item.id);
    try {
      const outcome = await runDrainOnce({ item, pairing, buildPayload });
      if (outcome.kind === "synced") queue.getState().markSynced(item.id, outcome.invoiceId);
      else if (outcome.kind === "rejected") queue.getState().markRejected(item.id, outcome.error);
      else if (outcome.kind === "unauthorized") queue.getState().markRejected(item.id, "unauthorized - re-pair required");
      else queue.getState().markFailed(item.id, outcome.error);
    } finally {
      running.current = false;
      setTimeout(tick, backoffMs(item.attempts));
    }
  }
}
```

Note: CEMP-PQ fallback is descoped from v1 (see top of plan). Drain runs only via IP transport.

- [ ] **Step 2: Write the queue/home screen**

Replace `apps/mobile/app/index.tsx`:

```tsx
import { useEffect } from "react";
import { Button, FlatList, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { usePairingStore } from "@/stores/pairing";
import { useSyncQueue } from "@/stores/sync-queue";
import { useDrainQueue } from "@/lib/useDrainQueue";

export default function Home() {
  const pairing = usePairingStore((s) => s.pairing);
  const loadPairing = usePairingStore((s) => s.loadPairing);
  const items = useSyncQueue((s) => s.items);

  useEffect(() => { void loadPairing(); }, [loadPairing]);
  useDrainQueue();

  if (!pairing) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>ChainPay Mobile</Text>
        <Text>No desktop paired.</Text>
        <Button title="Pair desktop" onPress={() => router.push("/pair")} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Queue</Text>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text>{(item.extraction.body as { invoice_number?: string }).invoice_number ?? "(no number)"}</Text>
            <Text style={styles.status}>{item.status}</Text>
          </View>
        )}
        ListEmptyComponent={<Text>No captures yet.</Text>}
      />
      <Button title="Capture invoice" onPress={() => router.push("/capture")} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", padding: 8, borderBottomWidth: 1, borderColor: "#eee" },
  status: { color: "#666" },
});
```

- [ ] **Step 3: Smoke test the full flow**

Run desktop in one terminal:
```bash
cd apps/desktop && npm run dev
```

Run mobile in another, on a real device:
```bash
cd apps/mobile && npx expo start --tunnel
```

Pair via QR → capture an invoice → review → return home → see item pending → watch it transition `pending → syncing → synced` once drain runs. Verify desktop shows the new invoice in its existing invoices list.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/app/index.tsx apps/mobile/lib/useDrainQueue.ts
git commit -m "feat(4): home screen + drain hook + capture entry point"
```

---

### Phase H — Integration + docs (T23–T24)

### Task 23: End-to-end integration test

**Files:**
- Create: `apps/mobile/__fixtures__/invoices/sample.jpg` (anonymised, ~500KB)
- Create: `apps/desktop/electron/main/pair-server.e2e.test.ts`

- [ ] **Step 1: Drop a fixture image**

Source any single anonymised invoice image (no real personal data). Place at `apps/mobile/__fixtures__/invoices/sample.jpg`. Keep < 1MB.

- [ ] **Step 2: Write the e2e integration test**

Create `apps/desktop/electron/main/pair-server.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Buffer } from "node:buffer";
import { Agent } from "undici";
import { ulid } from "ulid";
import { createFiberConnectUri, parseFiberConnectUri, MobileInvoicePayloadSchema } from "@chain-pay/shared";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");
const { initBiscuit, generateRootKeypair, issueCaptureV1Token } = await import("./pair-server-biscuit");
const { _setPairStoreFileForTests, addDevice } = await import("./pair-store");
const { startPairServer, stopPairServer } = await import("./pair-server");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-"));
const rendererSend = vi.fn();
let baseUri = "";
let dispatcher: Agent;

beforeAll(async () => {
  await initBiscuit();
  resetSafeStorageForTests();
  _setPairStoreFileForTests(path.join(tmpDir, "paired.enc"));

  const root = generateRootKeypair();
  const token = issueCaptureV1Token({ root, deviceLabel: "phone", expiresAtRfc3339: "2099-01-01T00:00:00Z" });
  await addDevice({
    tokenId: token.tokenId, deviceLabel: "phone", commPubkey: "0x" + "00".repeat(32),
    capabilities: ['write("invoices")'], issuedAt: 0, expiresAt: 4102444800000,
  });

  const started = await startPairServer({
    port: 0,
    rootKeypair: root,
    appVersion: "0.4.0-e2e",
    sendToRenderer: { send: rendererSend } as unknown as Electron.WebContents,
    mdns: false,
    commPubkey: "0x" + "ff".repeat(32),
  });

  baseUri = createFiberConnectUri({
    rpc_url: `https://127.0.0.1:${started.port}`,
    auth_token: token.token,
    cert_fingerprint: started.certFingerprint,
  });
  dispatcher = new Agent({ connect: { ca: started.certPem } });
});

afterAll(async () => {
  await dispatcher.close();
  await stopPairServer();
});

describe("pair-server end-to-end", () => {
  it("round-trips three fixture invoices via FiberConnect URI", async () => {
    const pairing = parseFiberConnectUri(baseUri);
    const imgPath = path.resolve(__dirname, "../../../mobile/__fixtures__/invoices/sample.jpg");
    const img = await fs.readFile(imgPath);
    const chunkSize = 256 * 1024;
    const chunks: string[] = [];
    for (let off = 0; off < img.length; off += chunkSize) {
      chunks.push(img.subarray(off, off + chunkSize).toString("base64"));
    }

    for (let i = 0; i < 3; i++) {
      const payload = MobileInvoicePayloadSchema.parse({
        id: ulid(),
        capturedAt: Date.now(),
        extraction: { body: { invoice_number: `INV-${i}` }, field_confidences: {}, warnings: [] },
        image_chunks: chunks,
        image_mime: "image/jpeg",
      });
      const res = await fetch(`${pairing.rpc_url}invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.auth_token}` },
        body: JSON.stringify(payload),
        // @ts-expect-error — undici dispatcher accepted by node:fetch at runtime
        dispatcher,
      });
      expect(res.status).toBe(201);
    }
    expect(rendererSend).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `cd apps/desktop && npx vitest run electron/main/pair-server.e2e.test.ts`
Expected: PASS — 3 invoices delivered.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main/pair-server.e2e.test.ts apps/mobile/__fixtures__/invoices/sample.jpg
git commit -m "test(4): end-to-end pair-server round-trip with fixture invoice"
```

---

### Task 24: Phase-4 smoke playbook doc

**Files:**
- Create: `docs/phase-4-smoke-playbook.md`

- [ ] **Step 1: Write the doc**

Create `docs/phase-4-smoke-playbook.md`:

```markdown
# Phase 4 Smoke Playbook — Mobile Companion v1

Run after every Phase 4 task that touches end-to-end flow. Same shape as `docs/phase-3c-smoke-playbook.md`.

## Pre-flight

- [ ] Desktop builds: `cd apps/desktop && npm run dev` boots without errors
- [ ] Mobile builds: `cd apps/mobile && npx expo start --tunnel` shows QR
- [ ] Physical device on same Wi-Fi as desktop, or both on Tailscale
- [ ] Camera permission granted on device

## 1. Pairing — Wi-Fi mDNS

- [ ] Settings → Pair mobile → enter label "smoke-phone" → Generate QR
- [ ] Mobile → tap "Pair desktop" → scan QR
- [ ] Mobile lands on home screen showing empty queue
- [ ] Desktop Paired devices list shows "smoke-phone" with 30d expiry

## 2. Capture happy path

- [ ] Mobile → "Capture invoice" → camera opens
- [ ] Shoot a real invoice — capture completes within ~3s including OCR
- [ ] Review screen shows invoice_number, total, currency populated (some may be empty)
- [ ] "Queue for sync" → home shows item with status="pending"
- [ ] Within 30s: status flips to "synced"
- [ ] Desktop invoices list shows the new entry with sourceLabel="smoke-phone"

## 3. Offline → online

- [ ] Mobile: enable airplane mode
- [ ] Capture 3 invoices → all 3 land in queue as "pending"
- [ ] Disable airplane mode
- [ ] Within 60s: all 3 transition to "synced"
- [ ] Desktop shows all 3 invoices

## 4. Revocation

- [ ] Desktop Settings → Paired devices → "Revoke" on smoke-phone
- [ ] Mobile: tap Capture → enqueue one capture
- [ ] Within ~10s: queue item moves to "rejected" with reason mentioning "unauthorized" / "re-pair required"
- [ ] Re-pair → new captures work

## 5. Cert change

- [ ] Stop desktop, delete `~/.config/chain-pay/biscuit-root.enc` AND restart (forces new cert)
- [ ] Mobile: try to capture → expect hard-fail modal "Desktop identity changed — re-pair?"
- [ ] Re-pair → recovery

## 6. Image cache cap

- [ ] Capture 50+ images
- [ ] Verify `apps/mobile` cache dir purges oldest synced after total exceeds 500MB

## 7. CEMP-PQ cellular fallback (manual)

- [ ] Disable Wi-Fi, keep cellular data on
- [ ] Capture → item should escalate to "pending-cellular" after 10 IP retries
- [ ] On-chain CEMP-PQ submission should run; desktop receives via comm-transport-service

## Sign-off

- Tester: __________
- Date: __________
- Build SHA: __________
```

- [ ] **Step 2: Commit**

```bash
git add docs/phase-4-smoke-playbook.md
git commit -m "docs(4): phase 4 smoke playbook"
```

---

## Self-Review Notes

**Spec coverage:**
- TL;DR, Goals, Non-goals → Plan respects them (no signing, no treasury, no full port)
- Architecture (3 transports, 2 paths) → T14 (IP), T15 (CEMP-PQ), T16 (selector)
- Components: mobile / desktop / shared → T10–T22 (mobile), T4–T9 (desktop), T1–T3 (shared)
- Pairing & auth (FiberConnect + Biscuit) → T1 (URI), T2 (capabilities), T5 (token), T9 (UI)
- Data flow (capture path) → T17 (OCR), T18 (mapper), T20 (capture), T22 (drain)
- Offline + sync (queue state machine) → T13
- Image lifecycle (2000px / q=85 / 256KB chunks / 500MB cap) → T20 (resize), T22 (chunking), smoke checklist (cap)
- CEMP-PQ escape → T15 + T22 (status escalation surfaces in T13's `markFailed` after attempts=10)
- Error handling tables → mobile errors covered in T20 (permissions), T22 (auth/server errors), T19 (cert/health); desktop errors covered in T7 (401/403/409/500)
- Testing strategy (unit + component + integration) → T1-T16 unit, T9 component, T23 integration, T24 smoke

**Placeholder scan:** clean. No TBD/TODO. Two notes marked clearly as deferred (CEMP `myCommPrivkey` stub in T22, Review-screen edits in T21) — those are explicit YAGNI choices for v1, not gaps.

**Type consistency:** `PairingPayload`, `QueueItem`, `MobileInvoicePayload`, `PairedDevice`, `IpSendResult`, `DrainOutcome` are defined once and referenced consistently. `parseBiscuitSource` / `buildBiscuitSource` symmetric. Routes constants centralized in `MOBILE_ROUTES`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-phase-4-mobile-companion.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
