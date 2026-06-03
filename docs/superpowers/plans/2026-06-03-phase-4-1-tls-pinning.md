# Phase 4.1 — Mobile TLS Pinning + Cert Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real TLS pinning on mobile (via a custom Expo native module `expo-tls-pin` that verifies SHA-256 of presented cert DER against the runtime fingerprint), persist the desktop's self-signed cert across boots, add a user-triggered cert-rotation path, enforce mandatory cert_fingerprint at the scanner, and wire the image cache purge (`removeSynced(24h)` + 500MB cap).

**Architecture:** Native code on the mobile side replaces RN's platform-default `fetch` with a pinned alternative. Desktop cert moves from in-memory-per-boot to encrypted-on-disk with a rotate-on-demand IPC handler. No FiberConnect protocol change. No third-party TLS library. ~300 LOC of native code (Swift + Kotlin) plus ~400 LOC of TS changes spread across well-bounded files.

**Tech Stack:** Expo SDK 56 (custom local Expo module via `create-expo-module --local`), Swift (iOS `URLSessionDelegate`), Kotlin (Android `OkHttpClient` + `X509TrustManager`), Node `https` + `selfsigned` on the desktop, undici Agent CA pinning for the e2e test. Reuses existing `safe-storage`, vitest, and zustand stores from Phase 4.

**Spec:** `docs/superpowers/specs/2026-06-03-phase-4-1-tls-pinning-design.md`

---

## File-Level Inventory

### New files

```
apps/desktop/electron/main/tls-cert-store.ts                      (cert persistence on disk)
apps/desktop/electron/main/tls-cert-store.test.ts
apps/desktop/electron/main/pair-server-rotate.test.ts             (hot-swap proof)
apps/mobile/lib/transport/pinned-fetch.ts                         (JS adapter to native module)
apps/mobile/lib/transport/pinned-fetch.test.ts
apps/mobile/modules/expo-tls-pin/                                 (whole local Expo module — scaffolded)
   ios/ExpoTlsPinModule.swift                                     (URLSessionDelegate verifier)
   android/src/main/java/expo/modules/tlspin/ExpoTlsPinModule.kt  (OkHttp verifier)
   src/index.ts                                                   (TS facade)
   expo-module.config.json
   ExpoTlsPin.podspec
   build.gradle
```

### Modified files

```
apps/desktop/electron/main/pair-server.ts                        (consume injected cert, add restartWithCert)
apps/desktop/electron/main/pair-server.test.ts                   (assert restart)
apps/desktop/electron/main/pair-server.e2e.test.ts               (add rotation test)
apps/desktop/electron/main/index.ts                              (boot uses store, add pair:rotateCert IPC)
apps/desktop/electron/preload/index.ts                           (add pair.rotateCert)
apps/desktop/src/features/settings/PairingSection.tsx            (Rotate button + modal)
apps/desktop/src/features/settings/PairingSection.test.tsx       (test rotate)
apps/desktop/src/features/settings/Settings.tsx                  (refresh pairInfo after rotate)
apps/mobile/lib/transport/ip-client.ts                           (switch to pinnedFetch + tls-mismatch)
apps/mobile/lib/transport/ip-client.test.ts                      (adjust mocks + add tls-mismatch tests)
apps/mobile/lib/transport/index.ts                               (tls-mismatch DrainOutcome)
apps/mobile/lib/transport/index.test.ts                          (add tls-mismatch test)
apps/mobile/app/pair.tsx                                         (reject empty fingerprint)
apps/mobile/lib/useDrainQueue.ts                                 (tls-mismatch + removeSynced wiring)
apps/mobile/app/index.tsx                                        (adjusted not-paired copy)
apps/mobile/stores/pairing.ts                                    (wasAutoCleared flag)
apps/mobile/stores/pairing.test.ts                               (test the new flag)
apps/mobile/stores/sync-queue.test.ts                            (test removeSynced)
apps/mobile/vitest.setup.ts                                      (mock expo-tls-pin local module)
docs/phase-4-smoke-playbook.md                                   (resolve deferrals, add rotation + pin-enforcement sections)
```

---

## Task Decomposition

11 tasks, ordered so each lands on top of green tests. T1–T4 are pure desktop and ship a working rotate UI before any mobile code changes. T5 is the heaviest task (native module). T6–T9 are mobile JS. T10–T11 are integration test + docs.

---

### Task 1: Desktop TLS cert store

**Files:**
- Create: `apps/desktop/electron/main/tls-cert-store.ts`
- Create: `apps/desktop/electron/main/tls-cert-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/electron/main/tls-cert-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tls-cert-store-test-"));
const file = path.join(tmpDir, "tls-cert.enc");

const { _setTlsCertFileForTests, loadOrCreateTlsCert, rotateTlsCert, _resetTlsCertCacheForTests } =
  await import("./tls-cert-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(file, { force: true });
  _setTlsCertFileForTests(file);
  _resetTlsCertCacheForTests();
});

describe("tls-cert-store", () => {
  it("first call generates a new cert and persists it", async () => {
    const result = await loadOrCreateTlsCert();
    expect(result.key).toContain("BEGIN RSA PRIVATE KEY");
    expect(result.cert).toContain("BEGIN CERTIFICATE");
    expect(result.fingerprint).toMatch(/^[A-F0-9:]{95}$/);
    await fs.access(file); // file exists
  });

  it("second call returns the same persisted cert", async () => {
    const first = await loadOrCreateTlsCert();
    _resetTlsCertCacheForTests(); // force re-read from disk
    const second = await loadOrCreateTlsCert();
    expect(second.cert).toBe(first.cert);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("rotateTlsCert replaces the persisted cert with a new one", async () => {
    const first = await loadOrCreateTlsCert();
    const rotated = await rotateTlsCert();
    expect(rotated.cert).not.toBe(first.cert);
    expect(rotated.fingerprint).not.toBe(first.fingerprint);
    _resetTlsCertCacheForTests();
    const reread = await loadOrCreateTlsCert();
    expect(reread.cert).toBe(rotated.cert);
  });

  it("concurrent loadOrCreate calls share one cert generation", async () => {
    const [a, b] = await Promise.all([loadOrCreateTlsCert(), loadOrCreateTlsCert()]);
    expect(a.cert).toBe(b.cert);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/tls-cert-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/electron/main/tls-cert-store.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import selfsigned from "selfsigned";
import os from "node:os";
import { getSafeStorage } from "./safe-storage";

const nodeRequire = createRequire(__filename);

export interface TlsCert {
  key: string;
  cert: string;
  fingerprint: string;
}

interface StoredCert {
  key: string;
  cert: string;
  schemaVersion: 1;
}

let storeFile: string | null = null;
let cache: TlsCert | null = null;
let inFlight: Promise<TlsCert> | null = null;

function defaultUserDataDir(): string {
  return nodeRequire("electron").app.getPath("userData");
}

function resolveFile(): string {
  if (storeFile) return storeFile;
  return path.join(defaultUserDataDir(), "tls-cert.enc");
}

export function _setTlsCertFileForTests(file: string): void {
  storeFile = file;
}

export function _resetTlsCertCacheForTests(): void {
  cache = null;
  inFlight = null;
}

function fingerprintOf(certPem: string): string {
  const body = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  const der = Buffer.from(body, "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

function generate(): { key: string; cert: string } {
  const attrs = [{ name: "commonName", value: os.hostname() || "chainpay" }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 2, value: os.hostname() || "chainpay" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

async function readDiskCert(): Promise<StoredCert | null> {
  try {
    const buf = await fs.readFile(resolveFile());
    const json = getSafeStorage().decrypt(buf);
    return JSON.parse(json) as StoredCert;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeDiskCert(stored: StoredCert): Promise<void> {
  const enc = getSafeStorage().encrypt(JSON.stringify(stored));
  const target = resolveFile();
  const tmp = target + ".tmp";
  await fs.mkdir(path.dirname(target), { recursive: true });
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(enc);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

export async function loadOrCreateTlsCert(): Promise<TlsCert> {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const existing = await readDiskCert();
    if (existing) {
      const result: TlsCert = { key: existing.key, cert: existing.cert, fingerprint: fingerprintOf(existing.cert) };
      cache = result;
      return result;
    }
    const { key, cert } = generate();
    await writeDiskCert({ key, cert, schemaVersion: 1 });
    const result: TlsCert = { key, cert, fingerprint: fingerprintOf(cert) };
    cache = result;
    return result;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function rotateTlsCert(): Promise<TlsCert> {
  const { key, cert } = generate();
  await writeDiskCert({ key, cert, schemaVersion: 1 });
  const result: TlsCert = { key, cert, fingerprint: fingerprintOf(cert) };
  cache = result;
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/tls-cert-store.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify full suite + tsc clean**

```bash
cd apps/desktop && npx vitest run --reporter=dot 2>&1 | tail -3
cd apps/desktop && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 573+4=577 tests passing (baseline was 573), tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/tls-cert-store.ts apps/desktop/electron/main/tls-cert-store.test.ts
git commit -m "feat(4.1): persisted TLS cert store with rotate-on-demand"
```

---

### Task 2: pair-server consumes injected cert + restartWithCert

**Files:**
- Modify: `apps/desktop/electron/main/pair-server.ts`
- Modify: `apps/desktop/electron/main/pair-server.test.ts`

- [ ] **Step 1: Update test expectations for the new shape**

`pair-server.test.ts`'s `beforeAll` currently lets `startPairServer` generate its own cert. Change the test so it now takes a `tlsCert: {key, cert}` argument from `loadOrCreateTlsCert()`. Add one new test for `restartWithCert` hot-swap.

Add at the top of the test file with the other imports:

```ts
const { _setTlsCertFileForTests, _resetTlsCertCacheForTests, loadOrCreateTlsCert } = await import("./tls-cert-store");
```

In `beforeAll`, before `startPairServer`:

```ts
const tlsTmpFile = path.join(tmpDir, "tls-cert.enc");
_setTlsCertFileForTests(tlsTmpFile);
_resetTlsCertCacheForTests();
const tlsCert = await loadOrCreateTlsCert();
```

Pass `tlsCert` to `startPairServer({..., tlsCert})`.

Add this new test inside the existing `describe("pair-server routes", ...)`:

```ts
it("restartWithCert hot-swaps the cert and exposes a new fingerprint", async () => {
  const { rotateTlsCert } = await import("./tls-cert-store");
  const newCert = await rotateTlsCert();
  const { restartWithCert } = await import("./pair-server");
  const started = await restartWithCert({ key: newCert.key, cert: newCert.cert });
  expect(started.certFingerprint).toBe(newCert.fingerprint);
  expect(started.certFingerprint).not.toBe(certFingerprint);

  // health still works at the new fingerprint
  const newDispatcher = new Agent({ connect: { ca: started.certPem } });
  const r = await fetch(`https://127.0.0.1:${started.port}/health`, {
    // @ts-expect-error
    dispatcher: newDispatcher,
  });
  expect(r.status).toBe(200);
  await newDispatcher.close();
});
```

- [ ] **Step 2: Run test to verify the impl changes fail (RED)**

```bash
cd apps/desktop && npx vitest run electron/main/pair-server.test.ts
```
Expected: FAIL — `tlsCert` arg not recognized, `restartWithCert` undefined.

- [ ] **Step 3: Modify the implementation**

In `apps/desktop/electron/main/pair-server.ts`:

(a) Add to `StartArgs` interface:

```ts
interface StartArgs {
  port: number;
  rootKeypair: RootKeypair;
  appVersion: string;
  sendToRenderer: Electron.WebContents;
  mdns: boolean;
  commPubkey: string;
  tlsCert: { key: string; cert: string };
}
```

(b) Remove the in-line `selfsigned.generate(...)` call from inside `startPairServer`. Use the injected cert instead:

```ts
const fingerprint = sha256Fingerprint(args.tlsCert.cert);
const server = https.createServer(
  { key: args.tlsCert.key, cert: args.tlsCert.cert },
  async (req, res) => { /* ...unchanged... */ },
);
```

Remove the `import selfsigned from "selfsigned"` line and the `attrs`/`pems` local variables. Also keep the `os` import (still used for hostname in bonjour).

In `startPairServer`'s return:

```ts
return { port, certFingerprint: fingerprint, certPem: args.tlsCert.cert };
```

(c) Add the new `restartWithCert` export after `stopPairServer`:

```ts
export async function restartWithCert(tlsCert: { key: string; cert: string }): Promise<StartResult> {
  if (!serverHandle) throw new Error("pair-server not running");
  const previousArgs = serverHandle.args;
  await stopPairServer();
  return startPairServer({ ...previousArgs, tlsCert });
}
```

(d) Capture `args` in `serverHandle` so `restartWithCert` can reuse them. Update the handle type and assignment:

```ts
let serverHandle: { server: https.Server; bonjour: Bonjour | null; args: StartArgs } | null = null;
// ...
serverHandle = { server, bonjour, args };
```

- [ ] **Step 4: Run tests + tsc**

```bash
cd apps/desktop && npx vitest run electron/main/pair-server.test.ts
cd apps/desktop && npx tsc --noEmit; echo "tsc=$?"
```
Expected: PASS — 8 existing + 1 new = 9 tests. tsc exit 0.

- [ ] **Step 5: Confirm no global regression**

```bash
cd apps/desktop && npx vitest run --reporter=dot 2>&1 | tail -3
```
Expected: 577 + 1 = 578 passed, 4 skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/pair-server.ts apps/desktop/electron/main/pair-server.test.ts
git commit -m "refactor(4.1): pair-server accepts injected TLS cert + restartWithCert"
```

---

### Task 3: Wire pair-server boot to tls-cert-store + pair:rotateCert IPC

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/preload/index.ts`

- [ ] **Step 1: Wire boot to use the cert store**

In `apps/desktop/electron/main/index.ts`, find the existing `bootPairServer` function. Change the `startPairServer` call to use the persisted cert:

```ts
import { loadOrCreateTlsCert, rotateTlsCert } from "./tls-cert-store";
import { restartWithCert } from "./pair-server";

async function bootPairServer(webContents: Electron.WebContents): Promise<void> {
  await initBiscuit();
  const root = await loadOrCreateRootKeypair();
  const tlsCert = await loadOrCreateTlsCert();
  const { publicInfo } = await import("./comm-transport-service");
  const info = await publicInfo();
  const started = await startPairServer({
    port: 8233,
    rootKeypair: root,
    appVersion: app.getVersion(),
    sendToRenderer: webContents,
    mdns: true,
    commPubkey: info?.mlKemPub ?? "0x" + "00".repeat(32),
    tlsCert: { key: tlsCert.key, cert: tlsCert.cert },
  });
  serverInfoCache = { certFingerprint: started.certFingerprint, port: started.port };
}
```

- [ ] **Step 2: Add the pair:rotateCert IPC handler**

Add near the other `pair:*` handlers in `index.ts`:

```ts
ipcMain.handle("pair:rotateCert", async () => {
  try {
    const newCert = await rotateTlsCert();
    const started = await restartWithCert({ key: newCert.key, cert: newCert.cert });
    serverInfoCache = { certFingerprint: started.certFingerprint, port: started.port };
    return { ok: true as const, fingerprint: started.certFingerprint, port: started.port };
  } catch (e: unknown) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "rotate failed" };
  }
});
```

- [ ] **Step 3: Expose pair.rotateCert to renderer**

In `apps/desktop/electron/preload/index.ts`, add to the existing `pair` namespace alongside `revoke`, `issue`, etc.:

```ts
rotateCert: (): Promise<
  | { ok: true; fingerprint: string; port: number }
  | { ok: false; reason: string }
> => ipcRenderer.invoke("pair:rotateCert"),
```

- [ ] **Step 4: Smoke-launch the app**

```bash
cd apps/desktop && npm run dev
```

Verify: app boots normally, logs include "pair-server listening on 8233", `~/.config/chain-pay/tls-cert.enc` is created (or equivalent userData path on your OS). Quit the app, restart, verify same fingerprint shown in Settings → Pair mobile.

- [ ] **Step 5: Confirm no regression**

```bash
cd apps/desktop && npx vitest run --reporter=dot 2>&1 | tail -3
cd apps/desktop && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 578 passing, tsc 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts
git commit -m "feat(4.1): boot uses persisted TLS cert + pair:rotateCert IPC"
```

---

### Task 4: PairingSection Rotate button + confirmation modal

**Files:**
- Modify: `apps/desktop/src/features/settings/PairingSection.tsx`
- Modify: `apps/desktop/src/features/settings/PairingSection.test.tsx`
- Modify: `apps/desktop/src/features/settings/Settings.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/features/settings/PairingSection.test.tsx`:

```tsx
it("rotates cert when confirmed in modal and refreshes pairInfo", async () => {
  listMock.mockResolvedValue([
    { tokenId: "tok-1", deviceLabel: "phone-1", expiresAt: Date.now() + 86400000, capabilities: ['write("invoices")'], commPubkey: "0x00", issuedAt: 0 },
  ]);
  const rotateMock = vi.fn().mockResolvedValue({ ok: true, fingerprint: "FF:EE:DD", port: 8233 });
  const onCertRotated = vi.fn();
  (window as unknown as { chainpay: { pair: unknown } }).chainpay = {
    pair: {
      ...((window as unknown as { chainpay: { pair: object } }).chainpay.pair),
      rotateCert: rotateMock,
    },
  };
  render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" onCertRotated={onCertRotated} />);
  await userEvent.click(await screen.findByRole("button", { name: /rotate tls cert/i }));
  // confirmation modal appears showing paired device count
  expect(screen.getByText(/all currently paired phones \(1\)/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^rotate$/i }));
  await waitFor(() => expect(rotateMock).toHaveBeenCalled());
  expect(onCertRotated).toHaveBeenCalledWith({ fingerprint: "FF:EE:DD", port: 8233 });
});

it("shows error when rotate fails", async () => {
  listMock.mockResolvedValue([]);
  const rotateMock = vi.fn().mockResolvedValue({ ok: false, reason: "disk full" });
  (window as unknown as { chainpay: { pair: unknown } }).chainpay = {
    pair: {
      ...((window as unknown as { chainpay: { pair: object } }).chainpay.pair),
      rotateCert: rotateMock,
    },
  };
  render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" onCertRotated={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /rotate tls cert/i }));
  await userEvent.click(screen.getByRole("button", { name: /^rotate$/i }));
  expect(await screen.findByTestId("pair-error")).toHaveTextContent(/disk full/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/desktop && npx vitest run src/features/settings/PairingSection.test.tsx
```
Expected: FAIL — button not found, `onCertRotated` prop unknown.

- [ ] **Step 3: Modify `PairingSection.tsx`**

(a) Add `onCertRotated` to props:

```ts
interface PairingSectionProps {
  rpcHost: string;
  rpcPort: number;
  certFingerprint: string;
  onCertRotated?: (info: { fingerprint: string; port: number }) => void;
}
```

(b) Add the rotate state + handler near the existing `onIssue` / `onRevoke`:

```tsx
const [confirmingRotate, setConfirmingRotate] = useState(false);
const [rotating, setRotating] = useState(false);

const onRotateCert = async () => {
  setErrorMsg(null);
  setRotating(true);
  try {
    const result = await window.chainpay.pair.rotateCert();
    if (!result.ok) {
      setErrorMsg(result.reason);
    } else {
      props.onCertRotated?.({ fingerprint: result.fingerprint, port: result.port });
      setUri(null); // invalidate any displayed QR
      await refresh();
    }
  } finally {
    setRotating(false);
    setConfirmingRotate(false);
  }
};
```

(Adjust `props.onCertRotated` to match how props are destructured in the existing component.)

(c) Add the button + modal at the bottom of the `<section>`, after the paired devices list:

```tsx
<button type="button" onClick={() => setConfirmingRotate(true)}>
  Rotate TLS cert
</button>
{confirmingRotate && (
  <div role="dialog" aria-label="Confirm rotate">
    <p>
      Rotate TLS cert? All currently paired phones ({devices.length}) will
      stop working until they re-scan a new QR.
    </p>
    <button type="button" onClick={() => setConfirmingRotate(false)} disabled={rotating}>
      Cancel
    </button>
    <button type="button" onClick={onRotateCert} disabled={rotating}>
      Rotate
    </button>
  </div>
)}
```

- [ ] **Step 4: Modify `Settings.tsx` to refresh pairInfo on rotate**

In the existing `Settings.tsx` where `<PairingSection>` is rendered, pass `onCertRotated`:

```tsx
<PairingSection
  rpcHost="127.0.0.1"
  rpcPort={pairInfo.port}
  certFingerprint={pairInfo.certFingerprint}
  onCertRotated={(info) => setPairInfo({ certFingerprint: info.fingerprint, port: info.port })}
/>
```

(`setPairInfo` is the existing useState setter for the `pairInfo` cache.)

- [ ] **Step 5: Run tests**

```bash
cd apps/desktop && npx vitest run src/features/settings/PairingSection.test.tsx
cd apps/desktop && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 4 existing + 2 new = 6 tests pass; tsc 0.

- [ ] **Step 6: Confirm full suite green**

```bash
cd apps/desktop && npx vitest run --reporter=dot 2>&1 | tail -3
```
Expected: 580 passing, 4 skipped.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/settings/PairingSection.tsx apps/desktop/src/features/settings/PairingSection.test.tsx apps/desktop/src/features/settings/Settings.tsx
git commit -m "feat(4.1): Rotate TLS cert button + confirmation modal"
```

---

### Task 5: Scaffold + implement the `expo-tls-pin` local Expo module

**Files:**
- Create: `apps/mobile/modules/expo-tls-pin/` (whole module tree)

This is the heaviest task — native code for both platforms. Steps split into scaffold + iOS + Android + TS facade.

- [ ] **Step 1: Scaffold the local module**

From `/home/phill/chain-pay/apps/mobile`:

```bash
npx create-expo-module@latest --local expo-tls-pin
```

When prompted:
- **Module name:** `expo-tls-pin`
- **JS package name:** `expo-tls-pin`
- **Author / description:** anything; will be edited in `expo-module.config.json` if needed.

The CLI generates `apps/mobile/modules/expo-tls-pin/` with iOS Swift, Android Kotlin, TS facade, and expo-module.config.json. Verify the tree:

```bash
ls apps/mobile/modules/expo-tls-pin/
```
Expected: `android/`, `ios/`, `src/`, `expo-module.config.json`, `package.json`, `ExpoTlsPin.podspec`, `build.gradle`.

- [ ] **Step 2: Replace the TS facade**

Open the generated `apps/mobile/modules/expo-tls-pin/src/index.ts` and replace its contents with:

```ts
import { requireNativeModule } from "expo-modules-core";

interface NativeModuleShape {
  request(args: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    fingerprint: string;
  }): Promise<{
    ok: true;
    status: number;
    headers: Record<string, string>;
    body: string;
  } | {
    ok: false;
    kind: "tls-mismatch" | "network";
    detail: string;
  }>;
}

const native = requireNativeModule<NativeModuleShape>("ExpoTlsPin");

export const ExpoTlsPin = native;
```

Delete any other auto-generated `.ts` files in `src/` (e.g., view stubs, event stubs).

- [ ] **Step 3: Implement iOS Swift verifier**

Replace `apps/mobile/modules/expo-tls-pin/ios/ExpoTlsPinModule.swift` with:

```swift
import ExpoModulesCore
import CryptoKit

public class ExpoTlsPinModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoTlsPin")

    AsyncFunction("request") { (args: [String: Any], promise: Promise) in
      guard
        let urlStr = args["url"] as? String,
        let url = URL(string: urlStr),
        let method = args["method"] as? String,
        let headers = args["headers"] as? [String: String],
        let fingerprint = args["fingerprint"] as? String
      else {
        promise.resolve(["ok": false, "kind": "network", "detail": "invalid args"])
        return
      }
      let body = args["body"] as? String

      var request = URLRequest(url: url)
      request.httpMethod = method
      for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
      if let body = body { request.httpBody = body.data(using: .utf8) }

      let delegate = PinningDelegate(expectedFingerprint: fingerprint.replacingOccurrences(of: ":", with: "").uppercased())
      let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)

      let task = session.dataTask(with: request) { data, response, error in
        if let err = error as NSError? {
          if delegate.didMismatch {
            promise.resolve(["ok": false, "kind": "tls-mismatch", "detail": err.localizedDescription])
          } else {
            promise.resolve(["ok": false, "kind": "network", "detail": err.localizedDescription])
          }
          return
        }
        guard let http = response as? HTTPURLResponse, let data = data else {
          promise.resolve(["ok": false, "kind": "network", "detail": "no response"])
          return
        }
        var respHeaders: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
          if let ks = k as? String, let vs = v as? String { respHeaders[ks] = vs }
        }
        promise.resolve([
          "ok": true,
          "status": http.statusCode,
          "headers": respHeaders,
          "body": String(data: data, encoding: .utf8) ?? "",
        ])
      }
      task.resume()
    }
  }
}

class PinningDelegate: NSObject, URLSessionDelegate {
  let expectedFingerprint: String
  var didMismatch = false

  init(expectedFingerprint: String) {
    self.expectedFingerprint = expectedFingerprint
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let serverTrust = challenge.protectionSpace.serverTrust,
          let cert = SecTrustGetCertificateAtIndex(serverTrust, 0)
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let der = SecCertificateCopyData(cert) as Data
    let digest = SHA256.hash(data: der)
    let hex = digest.map { String(format: "%02X", $0) }.joined()
    if hex == expectedFingerprint {
      completionHandler(.useCredential, URLCredential(trust: serverTrust))
    } else {
      didMismatch = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}
```

- [ ] **Step 4: Implement Android Kotlin verifier**

Replace `apps/mobile/modules/expo-tls-pin/android/src/main/java/expo/modules/tlspin/ExpoTlsPinModule.kt` with:

```kotlin
package expo.modules.tlspin

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import java.security.cert.CertificateException
import java.io.IOException

class ExpoTlsPinModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoTlsPin")

    AsyncFunction("request") { args: Map<String, Any?>, promise: Promise ->
      try {
        val url = args["url"] as String
        val method = args["method"] as String
        @Suppress("UNCHECKED_CAST")
        val headers = (args["headers"] as Map<String, String>?) ?: emptyMap()
        val body = args["body"] as String?
        val expectedFp = (args["fingerprint"] as String).replace(":", "").uppercase()

        val mismatchFlag = MismatchFlag()
        val trustManager = PinningTrustManager(expectedFp, mismatchFlag)
        val sslContext = SSLContext.getInstance("TLS").apply {
          init(null, arrayOf<TrustManager>(trustManager), null)
        }
        val client = OkHttpClient.Builder()
          .sslSocketFactory(sslContext.socketFactory, trustManager)
          .hostnameVerifier { _, _ -> true }  // We pin by cert hash; CN/SAN check is separate.
          .build()

        val reqBuilder = Request.Builder().url(url)
        headers.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
        val requestBody = body?.toRequestBody("application/json".toMediaTypeOrNull())
        when (method.uppercase()) {
          "GET" -> reqBuilder.get()
          "POST" -> reqBuilder.post(requestBody!!)
          "PUT" -> reqBuilder.put(requestBody!!)
          "DELETE" -> if (requestBody != null) reqBuilder.delete(requestBody) else reqBuilder.delete()
          else -> reqBuilder.method(method, requestBody)
        }
        val request = reqBuilder.build()

        try {
          val response: Response = client.newCall(request).execute()
          val respHeaders = mutableMapOf<String, String>()
          response.headers.forEach { respHeaders[it.first] = it.second }
          val respBody = response.body?.string() ?: ""
          promise.resolve(mapOf(
            "ok" to true,
            "status" to response.code,
            "headers" to respHeaders,
            "body" to respBody,
          ))
        } catch (e: IOException) {
          if (mismatchFlag.tripped) {
            promise.resolve(mapOf("ok" to false, "kind" to "tls-mismatch", "detail" to (e.message ?: "")))
          } else {
            promise.resolve(mapOf("ok" to false, "kind" to "network", "detail" to (e.message ?: "")))
          }
        }
      } catch (t: Throwable) {
        promise.resolve(mapOf("ok" to false, "kind" to "network", "detail" to (t.message ?: "")))
      }
    }
  }
}

class MismatchFlag { var tripped = false }

class PinningTrustManager(private val expectedFp: String, private val flag: MismatchFlag) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("no cert presented")
    val der = leaf.encoded
    val digest = MessageDigest.getInstance("SHA-256").digest(der)
    val hex = digest.joinToString("") { "%02X".format(it) }
    if (hex != expectedFp) {
      flag.tripped = true
      throw CertificateException("TLS pin mismatch")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
```

- [ ] **Step 5: Verify the module compiles on the dev client**

```bash
cd apps/mobile && npx expo prebuild --clean
cd apps/mobile && npx expo run:android  # or run:ios if on macOS
```

If you don't have Android Studio / Xcode set up to actually build, defer this verification to the smoke test — the JS-side tests (Task 6) will mock the native module, so vitest stays independent. Note in your task report if device-build verification was skipped.

- [ ] **Step 6: Update vitest setup to mock the local module**

Append to `apps/mobile/vitest.setup.ts`:

```ts
vi.mock("expo-tls-pin", () => ({
  ExpoTlsPin: { request: vi.fn() },
}));
```

(Adjust the import path if the JS facade ended up exporting from a non-default location.)

- [ ] **Step 7: Confirm mobile vitest still green**

```bash
cd apps/mobile && npx vitest run --reporter=dot 2>&1 | tail -3
```
Expected: 34 passed (no new tests yet — module is plumbing).

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/modules/expo-tls-pin apps/mobile/vitest.setup.ts
git commit -m "feat(4.1): expo-tls-pin local Expo module (iOS URLSession + Android OkHttp)"
```

---

### Task 6: `pinned-fetch.ts` adapter

**Files:**
- Create: `apps/mobile/lib/transport/pinned-fetch.ts`
- Create: `apps/mobile/lib/transport/pinned-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/transport/pinned-fetch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pinnedFetch } from "./pinned-fetch";
import { ExpoTlsPin } from "expo-tls-pin";

const requestMock = ExpoTlsPin.request as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => requestMock.mockReset());

describe("pinned-fetch", () => {
  it("returns ok:true on a 200 response with body", async () => {
    requestMock.mockResolvedValue({ ok: true, status: 200, headers: { "content-type": "application/json" }, body: '{"hello":"world"}' });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toEqual({ hello: "world" });
    }
  });

  it("passes fingerprint through to the native module", async () => {
    requestMock.mockResolvedValue({ ok: true, status: 204, headers: {}, body: "" });
    await pinnedFetch("https://x:1/foo", { method: "POST", body: '{"a":1}', headers: { Authorization: "Bearer t" } }, "AB:CD:EF");
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://x:1/foo",
      method: "POST",
      body: '{"a":1}',
      headers: { Authorization: "Bearer t" },
      fingerprint: "AB:CD:EF",
    }));
  });

  it("returns kind=tls-mismatch when native module reports it", async () => {
    requestMock.mockResolvedValue({ ok: false, kind: "tls-mismatch", detail: "fingerprint mismatch" });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result).toEqual({ ok: false, kind: "tls-mismatch" });
  });

  it("returns kind=network on connection errors", async () => {
    requestMock.mockResolvedValue({ ok: false, kind: "network", detail: "ECONNREFUSED" });
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result).toEqual({ ok: false, kind: "network", detail: "ECONNREFUSED" });
  });

  it("returns kind=network if the native module throws", async () => {
    requestMock.mockRejectedValue(new Error("module crashed"));
    const result = await pinnedFetch("https://x:1/foo", { method: "GET" }, "AB:CD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("network");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/mobile && npx vitest run lib/transport/pinned-fetch.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/lib/transport/pinned-fetch.ts`:

```ts
import { ExpoTlsPin } from "expo-tls-pin";

export type PinnedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; kind: "tls-mismatch" }
  | { ok: false; kind: "network"; detail: string };

export async function pinnedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  fingerprint: string,
): Promise<PinnedFetchResult> {
  try {
    const result = await ExpoTlsPin.request({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
      fingerprint,
    });
    if (result.ok) {
      const response = new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
      return { ok: true, response };
    }
    if (result.kind === "tls-mismatch") return { ok: false, kind: "tls-mismatch" };
    return { ok: false, kind: "network", detail: result.detail };
  } catch (e) {
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/mobile && npx vitest run lib/transport/pinned-fetch.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Confirm full mobile suite + tsc**

```bash
cd apps/mobile && npx vitest run --reporter=dot 2>&1 | tail -3
cd apps/mobile && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 39 passed (34 + 5), tsc 0.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/transport/pinned-fetch.ts apps/mobile/lib/transport/pinned-fetch.test.ts
git commit -m "feat(4.1): pinned-fetch adapter wrapping expo-tls-pin"
```

---

### Task 7: ip-client switches to pinnedFetch + tls-mismatch propagation

**Files:**
- Modify: `apps/mobile/lib/transport/ip-client.ts`
- Modify: `apps/mobile/lib/transport/ip-client.test.ts`

- [ ] **Step 1: Adjust existing tests + add tls-mismatch tests**

Open `apps/mobile/lib/transport/ip-client.test.ts`. Replace the existing `fetchMock`/`globalThis.fetch` setup with the new shape using `pinnedFetch`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendInvoiceViaIp, healthCheck, fetchCommPubkey } from "./ip-client";
import * as pf from "./pinned-fetch";

const pinnedMock = vi.fn();
beforeEach(() => {
  pinnedMock.mockReset();
  vi.spyOn(pf, "pinnedFetch").mockImplementation(pinnedMock);
});
```

Replace each existing `fetchMock.mockResolvedValue(new Response(...))` call with:

```ts
pinnedMock.mockResolvedValue({ ok: true, response: new Response(JSON.stringify({ invoiceId: "inv_x" }), { status: 201 }) });
```

For the existing `401 returns unauthorized` case:

```ts
pinnedMock.mockResolvedValue({ ok: true, response: new Response("nope", { status: 401 }) });
```

For network rejection (replace `fetchMock.mockRejectedValue`):

```ts
pinnedMock.mockResolvedValue({ ok: false, kind: "network", detail: "ECONNREFUSED" });
```

Then add three new tests after the existing ones:

```ts
it("sendInvoice returns kind=tls-mismatch when pinned-fetch reports it", async () => {
  pinnedMock.mockResolvedValue({ ok: false, kind: "tls-mismatch" });
  const result = await sendInvoiceViaIp({ pairing, payload: {} as never });
  expect(result).toEqual({ ok: false, kind: "tls-mismatch" });
});

it("healthCheck returns false on tls-mismatch", async () => {
  pinnedMock.mockResolvedValue({ ok: false, kind: "tls-mismatch" });
  expect(await healthCheck(pairing)).toBe(false);
});

it("fetchCommPubkey returns null on tls-mismatch", async () => {
  pinnedMock.mockResolvedValue({ ok: false, kind: "tls-mismatch" });
  expect(await fetchCommPubkey(pairing)).toBeNull();
});
```

(The existing `pairing` fixture stays the same — it already has `cert_fingerprint: "AB:CD"`.)

- [ ] **Step 2: Run tests to confirm RED**

```bash
cd apps/mobile && npx vitest run lib/transport/ip-client.test.ts
```
Expected: existing tests fail because `globalThis.fetch` is no longer the surface; new tests fail because `tls-mismatch` not handled.

- [ ] **Step 3: Update the implementation**

Replace `apps/mobile/lib/transport/ip-client.ts` with:

```ts
import { MOBILE_ROUTES, type MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";
import { pinnedFetch } from "./pinned-fetch";

export type IpSendResult =
  | { ok: true; status: "created" | "duplicate"; invoiceId: string }
  | { ok: false; kind: "unauthorized" | "client" | "server" | "network" | "tls-mismatch"; detail?: string };

export async function sendInvoiceViaIp(args: {
  pairing: PairingPayload;
  payload: MobileInvoicePayload;
}): Promise<IpSendResult> {
  const url = new URL(MOBILE_ROUTES.invoices, args.pairing.rpc_url).toString();
  const result = await pinnedFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.pairing.auth_token}`,
      },
      body: JSON.stringify(args.payload),
    },
    args.pairing.cert_fingerprint,
  );
  if (!result.ok) {
    if (result.kind === "tls-mismatch") return { ok: false, kind: "tls-mismatch" };
    return { ok: false, kind: "network", detail: result.detail };
  }
  const res = result.response;
  if (res.status === 201) {
    const j = (await res.json()) as { invoiceId?: unknown };
    if (typeof j.invoiceId !== "string") return { ok: false, kind: "client", detail: "missing invoiceId in 201 response" };
    return { ok: true, status: "created", invoiceId: j.invoiceId };
  }
  if (res.status === 409) {
    const j = (await res.json()) as { invoiceId?: unknown };
    if (typeof j.invoiceId !== "string") return { ok: false, kind: "client", detail: "missing invoiceId in 409 response" };
    return { ok: true, status: "duplicate", invoiceId: j.invoiceId };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized" };
  if (res.status >= 400 && res.status < 500) return { ok: false, kind: "client", detail: await res.text() };
  return { ok: false, kind: "server", detail: await res.text() };
}

export async function healthCheck(pairing: PairingPayload): Promise<boolean> {
  const url = new URL(MOBILE_ROUTES.health, pairing.rpc_url).toString();
  const result = await pinnedFetch(url, { method: "GET" }, pairing.cert_fingerprint);
  if (!result.ok) return false;
  if (result.response.status !== 200) return false;
  const j = (await result.response.json()) as { ok?: boolean };
  return j.ok === true;
}

export async function fetchCommPubkey(pairing: PairingPayload): Promise<string | null> {
  const url = new URL(MOBILE_ROUTES.commPubkey, pairing.rpc_url).toString();
  const result = await pinnedFetch(url, { method: "GET" }, pairing.cert_fingerprint);
  if (!result.ok) return null;
  if (result.response.status !== 200) return null;
  const j = (await result.response.json()) as { comm_pubkey?: unknown };
  if (typeof j.comm_pubkey !== "string") return null;
  return j.comm_pubkey;
}
```

- [ ] **Step 4: Run tests + tsc**

```bash
cd apps/mobile && npx vitest run lib/transport/ip-client.test.ts
cd apps/mobile && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 9 existing (adjusted) + 3 new = 12 tests pass; tsc 0.

- [ ] **Step 5: Confirm no regression elsewhere**

```bash
cd apps/mobile && npx vitest run --reporter=dot 2>&1 | tail -3
```
Expected: 39 (T6 baseline) + 3 = 42 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/transport/ip-client.ts apps/mobile/lib/transport/ip-client.test.ts
git commit -m "feat(4.1): ip-client uses pinnedFetch + tls-mismatch propagation"
```

---

### Task 8: transport selector + drain — tls-mismatch outcome

**Files:**
- Modify: `apps/mobile/lib/transport/index.ts`
- Modify: `apps/mobile/lib/transport/index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `apps/mobile/lib/transport/index.test.ts`:

```ts
it("returns 'tls-mismatch' when ip-client reports it", async () => {
  vi.mocked(ip.sendInvoiceViaIp).mockResolvedValue({ ok: false, kind: "tls-mismatch" });
  const out = await runDrainOnce({ item, pairing, buildPayload });
  expect(out).toEqual({ kind: "tls-mismatch" });
});
```

- [ ] **Step 2: Run test to confirm RED**

```bash
cd apps/mobile && npx vitest run lib/transport/index.test.ts
```
Expected: FAIL — the `kind: "tls-mismatch"` outcome doesn't exist yet.

- [ ] **Step 3: Update the implementation**

In `apps/mobile/lib/transport/index.ts`, extend `DrainOutcome` and the mapping in `runDrainOnce`:

```ts
export type DrainOutcome =
  | { kind: "synced"; invoiceId: string }
  | { kind: "rejected"; error: string }
  | { kind: "unauthorized" }
  | { kind: "tls-mismatch" }
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
  if (result.kind === "tls-mismatch") return { kind: "tls-mismatch" };
  if (result.kind === "client") return { kind: "rejected", error: result.detail ?? "client error" };
  return { kind: "retry", error: result.detail ?? result.kind };
}
```

- [ ] **Step 4: Run tests + tsc**

```bash
cd apps/mobile && npx vitest run lib/transport/index.test.ts
cd apps/mobile && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 4 existing + 1 new = 5 pass; tsc 0.

- [ ] **Step 5: Confirm full suite**

```bash
cd apps/mobile && npx vitest run --reporter=dot 2>&1 | tail -3
```
Expected: 43 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/transport/index.ts apps/mobile/lib/transport/index.test.ts
git commit -m "feat(4.1): tls-mismatch DrainOutcome through transport selector"
```

---

### Task 9: pair.tsx enforces non-empty fingerprint + useDrainQueue handles tls-mismatch + cache purge wiring + Home banner

This task is larger because four related changes ride together. Each substep has its own test where the shape allows.

**Files:**
- Modify: `apps/mobile/stores/pairing.ts`
- Modify: `apps/mobile/stores/pairing.test.ts`
- Modify: `apps/mobile/stores/sync-queue.test.ts` (add removeSynced test only — impl already exists)
- Modify: `apps/mobile/lib/useDrainQueue.ts`
- Modify: `apps/mobile/app/pair.tsx`
- Modify: `apps/mobile/app/index.tsx`

- [ ] **Step 1: Add `wasAutoCleared` flag to pairing store (RED)**

Append to `apps/mobile/stores/pairing.test.ts`:

```ts
it("clearPairing with reason 'tls-mismatch' sets wasAutoCleared", async () => {
  await usePairingStore.getState().savePairing({
    rpc_url: "https://d:1/", auth_token: "t", cert_fingerprint: "AB",
    desktop_comm_pubkey: "0x" + "11".repeat(32),
  });
  await usePairingStore.getState().clearPairing("tls-mismatch");
  expect(usePairingStore.getState().wasAutoCleared).toBe(true);
});

it("savePairing clears the wasAutoCleared flag", async () => {
  await usePairingStore.getState().clearPairing("tls-mismatch");
  expect(usePairingStore.getState().wasAutoCleared).toBe(true);
  await usePairingStore.getState().savePairing({
    rpc_url: "https://d:1/", auth_token: "t", cert_fingerprint: "AB",
    desktop_comm_pubkey: "0x" + "22".repeat(32),
  });
  expect(usePairingStore.getState().wasAutoCleared).toBe(false);
});
```

- [ ] **Step 2: Run test to confirm RED**

```bash
cd apps/mobile && npx vitest run stores/pairing.test.ts
```
Expected: FAIL — `wasAutoCleared` undefined; `clearPairing` doesn't take an arg.

- [ ] **Step 3: Update pairing store**

In `apps/mobile/stores/pairing.ts`:

```ts
interface PairingState {
  pairing: PairingPayload | null;
  wasAutoCleared: boolean;
  savePairing: (p: PairingPayload) => Promise<void>;
  clearPairing: (reason?: "user" | "tls-mismatch") => Promise<void>;
  loadPairing: () => Promise<void>;
}

export const usePairingStore = create<PairingState>((set) => ({
  pairing: null,
  wasAutoCleared: false,
  savePairing: async (p) => {
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(p));
      set({ pairing: p, wasAutoCleared: false });
    } catch (e) {
      set({ pairing: null });
      throw e;
    }
  },
  clearPairing: async (reason = "user") => {
    try {
      await SecureStore.deleteItemAsync(KEY);
    } finally {
      set({ pairing: null, wasAutoCleared: reason === "tls-mismatch" });
    }
  },
  loadPairing: async () => {
    // ...existing validated-parse impl from Phase 4...
  },
}));

export function _resetPairingStoreForTests(): void {
  usePairingStore.setState({ pairing: null, wasAutoCleared: false });
}
```

(Keep the existing `loadPairing` body verbatim.)

- [ ] **Step 4: Add removeSynced test (the impl already exists from Phase 4)**

Append to `apps/mobile/stores/sync-queue.test.ts`:

```ts
it("removeSynced returns image refs for items older than threshold", () => {
  const now = Date.now();
  const oldId = useSyncQueue.getState().enqueue({ ...sample, capturedAt: now - 48 * 3600 * 1000, imageRef: "old.jpg" });
  const recentId = useSyncQueue.getState().enqueue({ ...sample, capturedAt: now, imageRef: "recent.jpg" });
  useSyncQueue.getState().markSynced(oldId, "inv_old");
  useSyncQueue.getState().markSynced(recentId, "inv_recent");
  const purged = useSyncQueue.getState().removeSynced(24 * 3600 * 1000);
  expect(purged).toEqual(["old.jpg"]);
  expect(useSyncQueue.getState().findById(oldId)).toBeUndefined();
  expect(useSyncQueue.getState().findById(recentId)).toBeDefined();
});
```

- [ ] **Step 5: Run sync-queue + pairing tests**

```bash
cd apps/mobile && npx vitest run stores/
```
Expected: all pass (pairing impl from Step 3 + existing removeSynced + new test).

- [ ] **Step 6: Update useDrainQueue.ts**

Replace `apps/mobile/lib/useDrainQueue.ts` with:

```ts
import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { File, Directory, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { IMAGE_CHUNK_BYTES, type MobileInvoicePayload } from "@chain-pay/shared";
import { useSyncQueue, backoffMs, type QueueItem } from "@/stores/sync-queue";
import { usePairingStore } from "@/stores/pairing";
import { runDrainOnce } from "@/lib/transport";

const IMAGE_CACHE_RETENTION_MS = 24 * 3600 * 1000;
const IMAGE_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function buildPayload(item: QueueItem): Promise<MobileInvoicePayload> {
  const file = new File(Paths.cache, item.imageRef);
  const b64 = await file.base64();
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

function deleteImagesFromCache(filenames: string[]): void {
  for (const name of filenames) {
    try {
      new File(Paths.cache, name).delete();
    } catch {
      // Best-effort; missing files are fine.
    }
  }
}

function cacheBytes(): number {
  try {
    const info = new Directory(Paths.cache).info();
    return info.size ?? 0;
  } catch {
    return 0;
  }
}

export function useDrainQueue(): void {
  const items = useSyncQueue((s) => s.items);
  const pairing = usePairingStore((s) => s.pairing);
  const queue = useSyncQueue;
  const pairingStore = usePairingStore;
  const running = useRef(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    NetInfo.fetch().then(() => {
      unsub = NetInfo.addEventListener(() => tick());
    });
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { tick(); }, [items.length, pairing?.auth_token]);

  // Periodic + capacity-driven cache purge.
  useEffect(() => {
    const purge = (): void => {
      const refs = queue.getState().removeSynced(IMAGE_CACHE_RETENTION_MS);
      deleteImagesFromCache(refs);
      if (cacheBytes() > IMAGE_CACHE_LIMIT_BYTES) {
        // Force-evict everything else that's synced regardless of age.
        const allSynced = queue.getState().items.filter((i) => i.status === "synced");
        if (allSynced.length > 0) {
          const moreRefs = queue.getState().removeSynced(0);
          deleteImagesFromCache(moreRefs);
        }
      }
    };
    purge();
    const id = setInterval(purge, PURGE_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tick(): Promise<void> {
    if (running.current || !pairing) return;
    const item = queue.getState().nextDrainCandidate();
    if (!item) return;
    running.current = true;
    queue.getState().markSyncing(item.id);
    try {
      const outcome = await runDrainOnce({ item, pairing, buildPayload });
      if (outcome.kind === "synced") {
        queue.getState().markSynced(item.id, outcome.invoiceId);
      } else if (outcome.kind === "rejected") {
        queue.getState().markRejected(item.id, outcome.error);
      } else if (outcome.kind === "unauthorized") {
        queue.getState().markRejected(item.id, "unauthorized - re-pair required");
      } else if (outcome.kind === "tls-mismatch") {
        queue.getState().markRejected(item.id, "tls-mismatch - re-pair required");
        await pairingStore.getState().clearPairing("tls-mismatch");
      } else {
        queue.getState().markFailed(item.id, outcome.error);
      }
    } finally {
      running.current = false;
      setTimeout(tick, backoffMs(item.attempts));
    }
  }
}
```

- [ ] **Step 7: Make pair.tsx reject empty fingerprint**

Modify `apps/mobile/app/pair.tsx`, replacing the `onScan` body:

```ts
const onScan = async ({ data }: { data: string }) => {
  if (busy) return;
  setBusy(true);
  try {
    const parsed = parseFiberConnectUri(data);
    if (!parsed.cert_fingerprint || parsed.cert_fingerprint.trim() === "") {
      Alert.alert("Invalid QR", "Pairing QR is missing the TLS certificate fingerprint.");
      setBusy(false);
      return;
    }
    const pairing = {
      rpc_url: parsed.rpc_url,
      auth_token: parsed.auth_token,
      cert_fingerprint: parsed.cert_fingerprint,
      desktop_comm_pubkey: "0x" + "00".repeat(32),
    };
    const healthy = await healthCheck(pairing);
    if (!healthy) {
      Alert.alert("Cannot reach desktop", "Make sure desktop ChainPay is running on this network, or that the certificate matches this pairing code.");
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
```

- [ ] **Step 8: Update Home (`index.tsx`) copy for auto-cleared case**

In `apps/mobile/app/index.tsx`, change the not-paired branch to read the new flag:

```tsx
const pairing = usePairingStore((s) => s.pairing);
const wasAutoCleared = usePairingStore((s) => s.wasAutoCleared);
// ...
if (!pairing) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>ChainPay Mobile</Text>
      <Text>{wasAutoCleared ? "Desktop identity changed — re-pair to reconnect." : "No desktop paired."}</Text>
      <Button title={wasAutoCleared ? "Re-pair desktop" : "Pair desktop"} onPress={() => router.push("/pair")} />
    </View>
  );
}
```

- [ ] **Step 9: Verify all mobile tests + tsc**

```bash
cd apps/mobile && npx vitest run --reporter=dot 2>&1 | tail -3
cd apps/mobile && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 43 + 2 pairing + 1 sync-queue = 46 passed; tsc 0.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/stores/pairing.ts apps/mobile/stores/pairing.test.ts apps/mobile/stores/sync-queue.test.ts apps/mobile/lib/useDrainQueue.ts apps/mobile/app/pair.tsx apps/mobile/app/index.tsx
git commit -m "feat(4.1): tls-mismatch auto-clear + cache purge + mandatory fingerprint at scanner"
```

---

### Task 10: e2e rotation test

**Files:**
- Modify: `apps/desktop/electron/main/pair-server.e2e.test.ts`

- [ ] **Step 1: Add the rotation test alongside the existing e2e**

The existing test boots `pair-server` and POSTs 3 invoices via `undici.Agent` with `ca: certPem`. Add this `it(...)` block inside the same `describe`:

```ts
it("rotates cert + verifies old dispatcher rejected + new dispatcher works", async () => {
  const { _setTlsCertFileForTests, _resetTlsCertCacheForTests, loadOrCreateTlsCert, rotateTlsCert } =
    await import("./tls-cert-store");
  const { restartWithCert } = await import("./pair-server");

  // The existing beforeAll didn't go through tls-cert-store; bootstrap one for this test.
  _setTlsCertFileForTests(path.join(tmpDir, "e2e-tls-cert.enc"));
  _resetTlsCertCacheForTests();
  await loadOrCreateTlsCert();

  const oldDispatcher = dispatcher;
  const rotated = await rotateTlsCert();
  const restarted = await restartWithCert({ key: rotated.key, cert: rotated.cert });

  // Old dispatcher's CA no longer matches → handshake fails.
  await expect(
    fetch(`https://127.0.0.1:${restarted.port}/health`, {
      // @ts-expect-error
      dispatcher: oldDispatcher,
    }),
  ).rejects.toThrow(/certificate|self-signed|altname|unable/i);

  // New dispatcher with the new CA succeeds.
  const newDispatcher = new Agent({ connect: { ca: restarted.certPem } });
  try {
    const res = await fetch(`https://127.0.0.1:${restarted.port}/health`, {
      // @ts-expect-error
      dispatcher: newDispatcher,
    });
    expect(res.status).toBe(200);
  } finally {
    await newDispatcher.close();
  }
});
```

- [ ] **Step 2: Run e2e**

```bash
cd apps/desktop && npx vitest run electron/main/pair-server.e2e.test.ts
```
Expected: 2 tests pass (existing 3-invoice + new rotation).

- [ ] **Step 3: Full suite + tsc**

```bash
cd apps/desktop && npx vitest run --reporter=dot 2>&1 | tail -3
cd apps/desktop && npx tsc --noEmit; echo "tsc=$?"
```
Expected: 580 + 1 = 581 passed (counting the new e2e), 4 skipped; tsc 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main/pair-server.e2e.test.ts
git commit -m "test(4.1): e2e rotation — old dispatcher rejected, new dispatcher accepted"
```

---

### Task 11: Update smoke playbook (resolve deferrals + add rotation + pin-enforcement sections)

**Files:**
- Modify: `docs/phase-4-smoke-playbook.md`

- [ ] **Step 1: Read the current "Known v1.1 Deferrals" section + the existing sections 5 / 5b / 6**

```bash
sed -n '40,90p' docs/phase-4-smoke-playbook.md
```

- [ ] **Step 2: Apply the doc changes**

Replace the "Known v1.1 Deferrals" section with a "Resolved in v1.1" callout at the top of the playbook:

```markdown
## Resolved in v1.1 (2026-06-03)

- TLS cert pinning on mobile: wired via the `expo-tls-pin` Expo module (SHA-256 verifier in `URLSession`/`OkHttp`). Mobile `pinned-fetch` rejects connections whose cert fingerprint doesn't match the value stored in the pairing record.
- Comm-pubkey TOFU: closed as a side effect of pinning — `/comm-pubkey` now travels through the pinned channel.
- Fail-open empty `cert_fingerprint`: closed at the scanner — `pair.tsx` rejects any QR missing a non-empty fingerprint.
- Image cache purge: wired in `useDrainQueue` (`removeSynced(24h)` on mount + every hour, plus a 500MB hard cap that evicts everything synced when exceeded).
```

Then update section 5 (was "Revocation") to the new rotation scenarios. Place these as sections 5a and 5b:

```markdown
## 5a. Cert rotation triggered by user

- [ ] Settings → Pair mobile → Rotate TLS cert → confirm modal shows paired-device count
- [ ] Within ~1s of confirming: QR display refreshes with a visibly different code
- [ ] Paired mobile: next sync attempt within 30s triggers TLS-mismatch → pairing auto-clears
- [ ] Home shows "Desktop identity changed — re-pair to reconnect" + the button text changes to "Re-pair desktop"
- [ ] Re-scan new QR → pairing restored → captures sync against the new cert

## 5b. Cert rotation triggered by desktop quit/restart

- [ ] Stop desktop. Inspect that `~/.config/chain-pay/tls-cert.enc` exists.
- [ ] Restart desktop. Mobile: capture an invoice → expect successful sync (cert persisted, same fingerprint)
- [ ] Delete `~/.config/chain-pay/tls-cert.enc` AND restart → cert regenerated → mobile sees TLS-mismatch → auto-re-pair flow as above

## 5c. TLS pin enforcement (negative test)

- [ ] On the desktop, temporarily edit `tls-cert-store.ts` to return a freshly-generated cert each call (or rotate without phone re-pairing)
- [ ] Mobile: trigger sync → expect TLS-mismatch outcome → queue items go to `rejected` with reason "tls-mismatch — re-pair required"
- [ ] Restore the cert (or re-pair) → drain resumes normally
```

Leave section 6 (image cache cap) in place but add a note at its top:

```markdown
> **Wired in v1.1** — `useDrainQueue` now calls `removeSynced(24h)` on mount + every hour, plus a 500MB hard cap that evicts all synced items when exceeded.
```

- [ ] **Step 3: Smoke read-through**

```bash
cat docs/phase-4-smoke-playbook.md | head -120
```

Confirm the new sections render reasonably and no orphan deferral list remains.

- [ ] **Step 4: Commit**

```bash
git add docs/phase-4-smoke-playbook.md
git commit -m "docs(4.1): playbook reflects v1.1 deliverables (rotation + pin enforcement)"
```

---

## Self-Review Notes

**1. Spec coverage:**

| Spec section | Covered by |
|---|---|
| TL;DR — TLS pinning via native module + cert persistence + rotation | T1 (store), T2-T3 (server consumes cert), T4 (UI rotate), T5 (native module), T6-T7 (mobile pinned-fetch + ip-client), T9 (TLS-mismatch handling) |
| Goals: pinning, persistence, rotation UI, TLS-mismatch UX, close 3 security findings, cache purge | Pinning T5+T6+T7; persistence T1; rotation UI T4; mismatch UX T9; security #1+#2 T6+T7; security #3 T9; cache purge T9 |
| Non-goals | None duplicated by accident |
| Architecture | T1 (boundary 1), T5+T6 (boundary 2), T4 (boundary 3) |
| Components — desktop | T1, T2, T3, T4 |
| Components — mobile | T5, T6, T7, T8, T9 |
| Native deps section | T5 (no third-party lib) |
| Pairing flow | T9 (mandatory fingerprint at scan) |
| Rotation flow | T4 (button + modal), T3 (IPC), T2 (restartWithCert) |
| Error handling — mobile | T9 (drain handler, banner, queue marking) |
| Error handling — desktop | T3 (handler error return), T2 (no implicit fallback added) |
| Threat coverage delta | All four "Closed" rows backed by T6 (pinning) + T9 (scanner enforcement) + T4+T2 (rotation visibility) |
| Testing — unit tests | T1, T2, T4, T6, T7, T8, T9 |
| Testing — e2e rotation | T10 |
| Smoke playbook updates | T11 |

No gaps.

**2. Placeholder scan:**

- No "TBD" / "TODO" / "implement later" left in steps.
- "Adjust the import path if the JS facade ended up exporting from a non-default location" (T5 Step 6) — flagged because the `create-expo-module` template generates the TS facade and its export shape may differ between CLI versions. Implementer adapts the mock path to whatever the scaffolded code produced. Acceptable.
- T5 Step 5 explicitly allows skipping device-build verification if Xcode/Android Studio aren't set up. The smoke playbook (T11) is the eventual verification.

**3. Type consistency:**

- `TlsCert` interface (T1) used in T2, T3, T10 — same `{key, cert, fingerprint}` shape.
- `StartArgs.tlsCert` (T2) consumed by `restartWithCert` (T2) and `bootPairServer` (T3) — consistent `{key, cert}` subshape.
- `PinnedFetchResult` (T6) consumed by `ip-client.ts` (T7) — consistent tagged union.
- `IpSendResult.kind = "tls-mismatch"` (T7) consumed by `runDrainOnce` (T8) and useDrainQueue (T9) — same string token throughout.
- `DrainOutcome.kind = "tls-mismatch"` (T8) consumed by `useDrainQueue` (T9) — same.
- `clearPairing(reason?: "user" | "tls-mismatch")` (T9 Step 3) consumed by `useDrainQueue` (T9 Step 6) — same signature.
- `wasAutoCleared` (T9 Step 3) read by `Home` (T9 Step 8) — same name.
- `pair.rotateCert()` return shape `{ok, fingerprint, port} | {ok, reason}` (T3) consumed by `PairingSection.tsx` (T4 Step 3) — same.
- `onCertRotated({fingerprint, port})` prop (T4) called from `Settings.tsx` (T4 Step 4) — same shape.

No drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-03-phase-4-1-tls-pinning.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Matches how Phase 4 shipped.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
