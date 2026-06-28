# JoyID Cross-Device Relay Signer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken JoyID popup signer with a cross-device (phone) QR relay so an SMB can connect a JoyID wallet and sign a whole CKB send transaction without desktop WebAuthn and without breaking the COOP-isolated light-client renderer.

**Architecture:** All relay logic runs in the **main renderer** — it is pure `fetch` + QR render + HTTP polling, so it needs no popup, no `window.opener`, and no separate BrowserWindow, and never trips the `Cross-Origin-Opener-Policy: same-origin` header that the embedded WASM light client requires. A new `JoyIdRelaySigner` implements the existing `CkbTxSigner` interface and drives a QR modal via an injected presenter; it talks to a deployed `joyid-relay` Cloudflare Worker (ported from `~/joyid-ckb-connector/packages/joyid-relay`). The phone performs the passkey ceremony on `testnet.joyid.dev` / `app.joy.id`; the Worker bridges the result back; the renderer assembles the CKB witness itself (DER→IEEE-P1363 conversion) and broadcasts via the light client.

**Tech Stack:** TypeScript, React 19, Zustand, `@ckb-ccc/core`, `@joyid/ckb@1.1.4`, `@joyid/common@0.2.2`, `qrcode`, Vitest. Relay backend: Cloudflare Worker + Durable Object (deployed separately, not in this repo).

## Global Constraints

- **Never custody keys (hard rule #1).** The renderer derives no key material; it only builds JoyID URLs, polls the relay, and assembles a witness from a signature the phone produced.
- **Light-client-first (hard rule #2).** Cell listing and broadcast continue to go through the embedded light client (`host.listCellsForLock`, `host.broadcastTransaction`). The relay is for signing transport only.
- **Adapters stay adapters (hard rule #3).** All JoyID/relay code lives under `apps/desktop/src/lib/signers/` and `apps/desktop/src/lib/chains/ckb/`. No relay logic in `features/` beyond the QR modal component and its store.
- **Every confirmed payment posts a JE (hard rule #5).** Unchanged — `buildAndSend` + the existing accounting reactor already handle this; this plan does not touch the accounting path.
- **JoyID versions are pinned and already correct:** `@joyid/ckb@1.1.4`, `@joyid/common@0.2.2` (identical to the proven `joyid-ckb-connector`). Do not bump them.
- **CkbTxSigner interface is fixed:** `kind: "joyid"`, `connect(): Promise<{ address: string; lockArgs: string }>`, `signTransaction(unsigned: Transaction): Promise<Transaction>`. New behaviour is injected via the constructor, not by changing the interface (so `buildAndSend` stays untouched).
- **Witness placeholder ≥ 1000 bytes** at the signing index before `completeFeeBy` (project CKB rule §1/§5). The existing `single-sig-tx-builder` already pads; do not regress it.
- **Files < 800 lines, functions < 50 lines, nesting ≤ 4, immutable updates, no `console.log`, no `any` (use `unknown` + narrowing).** Validate all relay/phone-origin data at the boundary with Zod before use (it is untrusted external input).
- **TDD + security review.** Signing/crypto code (Task 2 especially) lands only with tests first and a `security-reviewer` pass before merge.

---

## PREREQUISITE (human, not a code task) — clear before manual smoke

These block the live testnet smoke at the end, **not** the coded/unit-tested tasks. Do them in parallel with implementation.

1. **Deploy the relay Worker.** From `~/joyid-ckb-connector/packages/joyid-relay`, deploy to Cloudflare (`wrangler deploy`). Record its origin, e.g. `https://chainpay-joyid-relay.<account>.workers.dev`.
2. **Configure CORS allowlist on the Worker** to include the desktop renderer origin: dev `http://localhost:5173`, prod the packaged renderer origin. (The Worker's `corsHeaders()` reads an `allowedOrigins` allowlist — see `joyid-relay/src/worker.ts`.)
3. **JoyID redirect origin.** The Worker's `/session/:id/callback` is the `redirectURL`. Your feedback log (`2026-04-24 | joyid-ckb-connector + byterent-ui`) shows JoyID accepted a Worker-origin redirect on testnet with no dashboard step. **If** JoyID rejects the redirect origin at smoke time, register the Worker origin in the JoyID dapp dashboard for both `testnet.joyid.dev` and `app.joy.id`.
4. **Point chain-pay at the Worker** via the config in Task 7 (`VITE_JOYID_RELAY_URL` or the Settings field).

---

## File Structure

- `apps/desktop/src/lib/signers/joyid-relay/witness.ts` — **(new)** pure: base64url→hex normalization + DER→P1363 signature conversion + `buildSignedTx` wrapper. The security-critical, fully-unit-tested core.
- `apps/desktop/src/lib/signers/joyid-relay/witness.test.ts` — **(new)** golden-vector tests for `witness.ts`.
- `apps/desktop/src/lib/signers/joyid-relay/relay-client.ts` — **(new)** pure-ish HTTP wrapper around the relay Worker (`createSession`, `pollSession`, `createTxSession`) + JoyID URL builders. Injectable `fetch`.
- `apps/desktop/src/lib/signers/joyid-relay/relay-client.test.ts` — **(new)** request-shape + one-shot-poll tests with a mock fetch.
- `apps/desktop/src/lib/signers/joyid-relay/types.ts` — **(new)** Zod schemas + inferred types for relay/phone responses (`AuthResultSchema`, `SignResultSchema`, presenter interface).
- `apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.ts` — **(new)** `JoyIdRelaySigner implements CkbTxSigner`; orchestrates connect + sign via `relay-client` + `witness`, driving an injected presenter.
- `apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.test.ts` — **(new)** orchestration tests with mock relay-client + mock presenter.
- `apps/desktop/src/stores/joyid-sign.ts` — **(new)** Zustand store holding the QR-modal phase/url/preview/error.
- `apps/desktop/src/features/send/JoyIdSignModal.tsx` — **(new)** QR modal subscribed to the store.
- `apps/desktop/src/features/send/JoyIdSignModal.test.tsx` — **(new)** component test.
- `apps/desktop/src/lib/signers/joyid-relay/config.ts` — **(new)** relay URL + JoyID origin per network + poll constants.
- `apps/desktop/src/features/send/SendPanel.tsx` — **(modify ~line 189-196)** construct `JoyIdRelaySigner` + presenter instead of `JoyIdCkbTxSigner`; mount modal.
- `apps/desktop/src/features/send/SourceList.tsx` — **(modify ~line 19-26)** same swap for the connect flow; mount modal.
- `apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts` — **(modify)** mark deprecated; keep for reference until smoke passes, then delete in Task 9.

---

## Task 1: Relay response types + Zod schemas

**Files:**
- Create: `apps/desktop/src/lib/signers/joyid-relay/types.ts`
- Test: (covered indirectly by Tasks 2-4; no standalone test — pure schema declarations)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AuthResult = { address: string; pubkey: string; keyType: string }`
  - `SignResult = { signature: string; message: string; pubkey: string; keyType: string; alg: number }`
  - `AuthResultSchema`, `SignResultSchema` (Zod) and `parseDecoded<T>(schema, raw): T`
  - `SignPresenter` interface: `{ showQr(url: string, kind: "connect" | "sign", preview?: SignPreview): void; updateStatus(phase: SignPhase): void; dismiss(): void }`
  - `SignPhase = "idle" | "awaiting-scan" | "awaiting-confirm" | "assembling" | "done" | "error"`
  - `SignPreview = { to: { address: string; ckb: string }[]; feeCkb: string }`

- [ ] **Step 1: Write the file (pure types + schemas — no test of its own)**

```typescript
import { z } from "zod";

export const AuthResultSchema = z.object({
  address: z.string().min(1),
  pubkey: z.string().min(1),
  keyType: z.string().min(1),
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

export const SignResultSchema = z.object({
  signature: z.string().min(1),
  message: z.string().min(1),
  pubkey: z.string().min(1),
  keyType: z.string().min(1),
  alg: z.number(),
});
export type SignResult = z.infer<typeof SignResultSchema>;

/** Narrow untrusted relay/phone-origin data. `decodeSearch` returns `{ data, error }`. */
export function parseDecoded<T>(schema: z.ZodType<T>, decoded: unknown): T {
  if (decoded && typeof decoded === "object" && "error" in decoded && (decoded as { error?: unknown }).error) {
    throw new Error(`JoyID returned error: ${String((decoded as { error: unknown }).error)}`);
  }
  const data =
    decoded && typeof decoded === "object" && "data" in decoded
      ? (decoded as { data: unknown }).data
      : decoded;
  return schema.parse(data);
}

export type SignPhase =
  | "idle"
  | "awaiting-scan"
  | "awaiting-confirm"
  | "assembling"
  | "done"
  | "error";

export interface SignPreview {
  to: { address: string; ckb: string }[];
  feeCkb: string;
}

export interface SignPresenter {
  showQr(url: string, kind: "connect" | "sign", preview?: SignPreview): void;
  updateStatus(phase: SignPhase): void;
  dismiss(): void;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS (no references yet).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/signers/joyid-relay/types.ts
git commit -m "feat(send): JoyID relay response schemas + presenter contract"
```

---

## Task 2: Pure witness assembly (DER→P1363 + buildSignedTx)

This is the load-bearing, security-critical piece. Ported from `~/joyid-ckb-connector/packages/joyid-connect/src/signer.ts::assembleSignedTx`. The redirect/relay sign response carries a **DER-encoded ECDSA** signature in **base64url**; the on-chain JoyID lock needs **IEEE-P1363 `r‖s`, fixed 64 bytes**. Popup mode did this server-side; relay mode must do it here.

**Files:**
- Create: `apps/desktop/src/lib/signers/joyid-relay/witness.ts`
- Test: `apps/desktop/src/lib/signers/joyid-relay/witness.test.ts`

**Interfaces:**
- Consumes: `SignResult` (Task 1), `@joyid/common::base64urlToHex`, `@joyid/ckb::buildSignedTx`.
- Produces:
  - `derToP1363(hexSig: string): string` — returns 128-hex-char (64-byte) `r‖s`, no `0x`.
  - `normalizeSignResult(raw: SignResult): SignResult` — message+signature base64url→hex, signature DER→P1363.
  - `assembleSignedCkbTx(unsignedCkbTx: unknown, raw: SignResult, witnessIndexes: number[]): unknown` — returns a JoyID `CKBTransaction` (caller wraps in CCC `Transaction.from`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { derToP1363, normalizeSignResult } from "./witness";

describe("derToP1363", () => {
  // DER: 30 44 02 20 <32B r> 02 20 <32B s>  → 64B r||s
  it("converts a 0x44-len DER sig with 32-byte r and s to 128 hex chars", () => {
    const r = "a".repeat(64);
    const s = "b".repeat(64);
    const der = "3044" + "0220" + r + "0220" + s;
    expect(derToP1363(der)).toBe(r + s);
  });

  it("strips a leading 0x00 sign byte and left-pads to 32 bytes", () => {
    // r is 33 bytes (leading 00 because high bit set), s is 31 bytes (needs pad)
    const r33 = "00" + "f".repeat(64); // 33 bytes -> keep last 64 hex
    const s31 = "c".repeat(62); // 31 bytes -> pad to 64
    const der = "30" + "43" + "0221" + r33 + "021f" + s31;
    const out = derToP1363(der);
    expect(out.length).toBe(128);
    expect(out.slice(0, 64)).toBe("f".repeat(64));
    expect(out.slice(64)).toBe(s31.padStart(64, "0"));
  });

  it("passes through an already-64-byte (128 hex) signature unchanged via normalize", () => {
    const already = "1".repeat(128);
    const out = normalizeSignResult({
      signature: already,
      message: "0xdead",
      pubkey: "0x01",
      keyType: "main_session_key",
      alg: -7,
    });
    expect(out.signature).toBe(already);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay/witness.test.ts`
Expected: FAIL — "Cannot find module './witness'".

- [ ] **Step 3: Write minimal implementation**

```typescript
import { base64urlToHex } from "@joyid/common";
import { buildSignedTx } from "@joyid/ckb";
import type { SignResult } from "./types";

function stripHexPrefix(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

const HEX_RE = /^(0x)?[0-9a-f]*$/i;

function toHexMaybeBase64url(value: string): string {
  // Already hex? keep. Otherwise treat as base64url.
  return HEX_RE.test(value) ? stripHexPrefix(value) : stripHexPrefix(base64urlToHex(value));
}

/** DER ECDSA (30 LEN 02 rLen r 02 sLen s) → IEEE-P1363 r||s, 64 bytes / 128 hex. */
export function derToP1363(derHexInput: string): string {
  const der = stripHexPrefix(derHexInput);
  const bytes: number[] = [];
  for (let i = 0; i < der.length; i += 2) bytes.push(parseInt(der.slice(i, i + 2), 16));
  // bytes[0]=0x30 seq, bytes[1]=total len, bytes[2]=0x02 int, bytes[3]=rLen
  const rLen = bytes[3];
  const rStart = 4;
  const rEnd = rStart + rLen;
  const sLen = bytes[rEnd + 1];
  const sStart = rEnd + 2;
  const sEnd = sStart + sLen;
  const toHex = (arr: number[]) => arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  let r = toHex(bytes.slice(rStart, rEnd));
  let s = toHex(bytes.slice(sStart, sEnd));
  r = r.length > 64 ? r.slice(-64) : r.padStart(64, "0");
  s = s.length > 64 ? s.slice(-64) : s.padStart(64, "0");
  return r + s;
}

export function normalizeSignResult(raw: SignResult): SignResult {
  const message = "0x" + toHexMaybeBase64url(raw.message);
  let signature = toHexMaybeBase64url(raw.signature);
  if (signature.length !== 128) signature = derToP1363(signature);
  return { ...raw, message, signature: "0x" + signature };
}

export function assembleSignedCkbTx(
  unsignedCkbTx: unknown,
  raw: SignResult,
  witnessIndexes: number[],
): unknown {
  const normalized = normalizeSignResult(raw);
  // buildSignedTx expects the joyid CKBTransaction + SignMessageResponseData shape.
  return buildSignedTx(
    unsignedCkbTx as never,
    normalized as never,
    witnessIndexes,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay/witness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/signers/joyid-relay/witness.ts apps/desktop/src/lib/signers/joyid-relay/witness.test.ts
git commit -m "feat(send): pure JoyID witness assembly (DER->P1363 + buildSignedTx)"
```

---

## Task 3: Relay config (URLs, origins, poll constants)

**Files:**
- Create: `apps/desktop/src/lib/signers/joyid-relay/config.ts`
- Test: none (constants + one trivial selector — exercised by Task 4).

**Interfaces:**
- Consumes: `CkbNetwork` from `@/lib/light-client/network-configs`.
- Produces:
  - `joyidOrigin(network: CkbNetwork): string` → `https://testnet.joyid.dev` | `https://app.joy.id`
  - `relayBaseUrl(): string` (reads `import.meta.env.VITE_JOYID_RELAY_URL`, throws if unset)
  - `POLL_INTERVAL_MS = 2000`, `POLL_TIMEOUT_MS = 120000`
  - `DAPP = { name: "ChainPay", logo: "https://chainpay.local/logo.png" }`

- [ ] **Step 1: Write the file**

```typescript
import type { CkbNetwork } from "@/lib/light-client/network-configs";

export const POLL_INTERVAL_MS = 2000;
export const POLL_TIMEOUT_MS = 120_000;
export const DAPP = { name: "ChainPay", logo: "https://chainpay.local/logo.png" } as const;

export function joyidOrigin(network: CkbNetwork): string {
  return network === "mainnet" ? "https://app.joy.id" : "https://testnet.joyid.dev";
}

export function relayBaseUrl(): string {
  const url = import.meta.env.VITE_JOYID_RELAY_URL as string | undefined;
  if (!url) {
    throw new Error(
      "JoyID relay not configured. Set VITE_JOYID_RELAY_URL to the deployed joyid-relay Worker origin.",
    );
  }
  return url.replace(/\/$/, "");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/signers/joyid-relay/config.ts
git commit -m "feat(send): JoyID relay config (origins, worker url, poll constants)"
```

---

## Task 4: Relay client (HTTP wrapper + URL builders)

**Files:**
- Create: `apps/desktop/src/lib/signers/joyid-relay/relay-client.ts`
- Test: `apps/desktop/src/lib/signers/joyid-relay/relay-client.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 3 config, `@joyid/common::{ buildJoyIDURL, buildJoyIDSignMessageURL, decodeSearch }`.
- Produces a `RelayClient` class constructed with `{ network: CkbNetwork; fetchImpl?: typeof fetch }`:
  - `createSession(): Promise<{ id: string; callbackUrl: string }>`
  - `pollSession(id: string): Promise<unknown>` — resolves the decoded `_data_` (one-shot; rejects on timeout)
  - `buildAuthUrl(callbackUrl: string): string`
  - `buildSignUrl(args: { callbackUrl: string; challenge: string; address: string }): string`
  - `createTxSession(args: { id: string; joyidSignUrl: string; preview: unknown }): Promise<{ launchUrl: string }>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { RelayClient } from "./relay-client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("RelayClient", () => {
  it("createSession posts to /session and returns id + callbackUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "abc", ttl: 120 }));
    vi.stubGlobal("__VITE_JOYID_RELAY_URL__", undefined);
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test" });
    const res = await c.createSession();
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.test/session", expect.objectContaining({ method: "POST" }));
    expect(res).toEqual({ id: "abc", callbackUrl: "https://relay.test/session/abc/callback" });
  });

  it("pollSession resolves decoded data and stops polling on first hit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: null, expired: false }))
      .mockResolvedValueOnce(jsonResponse({ data: "ZW5jb2RlZA", expired: false }));
    const c = new RelayClient({ network: "testnet", fetchImpl, baseUrl: "https://relay.test", pollIntervalMs: 1 });
    const decoded = await c.pollSession("abc");
    expect(decoded).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("buildSignUrl targets the testnet origin and embeds the challenge", () => {
    const c = new RelayClient({ network: "testnet", fetchImpl: vi.fn(), baseUrl: "https://relay.test" });
    const url = c.buildSignUrl({ callbackUrl: "https://relay.test/session/abc/callback", challenge: "0xbeef", address: "ckt1q..." });
    expect(url).toContain("testnet.joyid.dev");
    expect(url).toContain("challenge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay/relay-client.test.ts`
Expected: FAIL — "Cannot find module './relay-client'".

- [ ] **Step 3: Write minimal implementation**

```typescript
import { buildJoyIDURL, buildJoyIDSignMessageURL, decodeSearch } from "@joyid/common";
import type { CkbNetwork } from "@/lib/light-client/network-configs";
import { DAPP, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, joyidOrigin, relayBaseUrl } from "./config";

interface RelayClientOpts {
  network: CkbNetwork;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class RelayClient {
  private readonly network: CkbNetwork;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(opts: RelayClientOpts) {
    this.network = opts.network;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? relayBaseUrl()).replace(/\/$/, "");
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async createSession(): Promise<{ id: string; callbackUrl: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/session`, { method: "POST" });
    if (!res.ok) throw new Error(`relay /session failed: ${res.status}`);
    const body = (await res.json()) as { id: string };
    return { id: body.id, callbackUrl: `${this.baseUrl}/session/${body.id}/callback` };
  }

  async createTxSession(args: { id: string; joyidSignUrl: string; preview: unknown }): Promise<{ launchUrl: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/tx-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`relay /tx-session failed: ${res.status}`);
    return (await res.json()) as { launchUrl: string };
  }

  async pollSession(id: string): Promise<unknown> {
    const deadline = this.pollTimeoutMs;
    let waited = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.fetchImpl(`${this.baseUrl}/session/${id}`);
      if (res.ok) {
        const body = (await res.json()) as { data: string | null; expired?: boolean };
        if (body.expired) throw new Error("JoyID session expired");
        if (body.data) return decodeSearch(body.data);
      }
      waited += this.pollIntervalMs;
      if (waited >= deadline) throw new Error("JoyID session timed out (no phone response)");
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  buildAuthUrl(callbackUrl: string): string {
    return buildJoyIDURL(
      { redirectURL: callbackUrl, name: DAPP.name, logo: DAPP.logo, joyidAppURL: joyidOrigin(this.network) },
      "redirect",
      "/auth",
    );
  }

  buildSignUrl(args: { callbackUrl: string; challenge: string; address: string }): string {
    return buildJoyIDSignMessageURL(
      {
        redirectURL: args.callbackUrl,
        name: DAPP.name,
        logo: DAPP.logo,
        joyidAppURL: joyidOrigin(this.network),
        challenge: args.challenge,
        isData: false,
        address: args.address,
      },
      "redirect",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay/relay-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/signers/joyid-relay/relay-client.ts apps/desktop/src/lib/signers/joyid-relay/relay-client.test.ts
git commit -m "feat(send): JoyID relay HTTP client + URL builders"
```

---

## Task 5: JoyIdRelaySigner (orchestrates connect + sign)

**Files:**
- Create: `apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.ts`
- Test: `apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.test.ts`

**Interfaces:**
- Consumes: `CkbTxSigner` (`@/lib/signers/ckb-tx-signer`), `RelayClient` (Task 4), `assembleSignedCkbTx` (Task 2), `AuthResultSchema`/`SignResultSchema`/`parseDecoded`/`SignPresenter` (Task 1), `@joyid/ckb::calculateChallenge`, CCC `Transaction`.
- Produces: `class JoyIdRelaySigner implements CkbTxSigner` constructed with
  `{ network: CkbNetwork; address?: string; presenter: SignPresenter; client?: RelayClient }`.
  - `witnessIndexes` for the single-source builder = every input index (all inputs share the JoyID source lock; the builder never mixes foreign-lock inputs). Documented invariant.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import { JoyIdRelaySigner } from "./joyid-relay-ckb-tx-signer";

const presenter = { showQr: vi.fn(), updateStatus: vi.fn(), dismiss: vi.fn() };

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "s1", callbackUrl: "https://relay/session/s1/callback" }),
    buildAuthUrl: vi.fn().mockReturnValue("https://testnet.joyid.dev/auth?x"),
    buildSignUrl: vi.fn().mockReturnValue("https://testnet.joyid.dev/sign-message?x"),
    createTxSession: vi.fn().mockResolvedValue({ launchUrl: "https://relay/tx-launch/s1" }),
    pollSession: vi.fn(),
    ...overrides,
  } as unknown as import("./joyid-relay/relay-client").RelayClient;
}

describe("JoyIdRelaySigner", () => {
  it("connect renders the auth QR and returns the address from the phone result", async () => {
    const client = fakeClient({
      pollSession: vi.fn().mockResolvedValue({ data: { address: "ckt1qrelay", pubkey: "0xpub", keyType: "main_session_key" } }),
    });
    const signer = new JoyIdRelaySigner({ network: "testnet", presenter, client });
    const res = await signer.connect();
    expect((client as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession).toHaveBeenCalled();
    expect(presenter.showQr).toHaveBeenCalledWith("https://testnet.joyid.dev/auth?x", "connect");
    expect(res.address).toBe("ckt1qrelay");
    expect(presenter.dismiss).toHaveBeenCalled();
  });

  it("signTransaction throws if no address is known", async () => {
    const signer = new JoyIdRelaySigner({ network: "testnet", presenter, client: fakeClient() });
    await expect(signer.signTransaction(Transaction.from({}))).rejects.toThrow(/address unknown/i);
  });

  it("signTransaction dismisses the modal and rethrows on poll failure", async () => {
    const client = fakeClient({ pollSession: vi.fn().mockRejectedValue(new Error("timed out")) });
    const signer = new JoyIdRelaySigner({ network: "testnet", address: "ckt1qsrc", presenter, client });
    await expect(signer.signTransaction(Transaction.from({ inputs: [], outputs: [], outputsData: [], witnesses: [] }))).rejects.toThrow(/timed out/);
    expect(presenter.dismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay-ckb-tx-signer.test.ts`
Expected: FAIL — "Cannot find module './joyid-relay-ckb-tx-signer'".

- [ ] **Step 3: Write minimal implementation**

```typescript
import { Transaction } from "@ckb-ccc/core";
import type { TransactionLike } from "@ckb-ccc/core";
import { calculateChallenge } from "@joyid/ckb";
import type { CkbNetwork } from "@/lib/light-client/network-configs";
import type { CkbTxSigner } from "./ckb-tx-signer";
import { RelayClient } from "./joyid-relay/relay-client";
import { assembleSignedCkbTx } from "./joyid-relay/witness";
import { AuthResultSchema, SignResultSchema, parseDecoded, type SignPresenter } from "./joyid-relay/types";

interface JoyIdRelaySignerOpts {
  network: CkbNetwork;
  presenter: SignPresenter;
  address?: string;
  client?: RelayClient;
}

export class JoyIdRelaySigner implements CkbTxSigner {
  readonly kind = "joyid" as const;
  private address: string;
  private readonly presenter: SignPresenter;
  private readonly client: RelayClient;

  constructor(opts: JoyIdRelaySignerOpts) {
    this.presenter = opts.presenter;
    this.address = opts.address ?? "";
    this.client = opts.client ?? new RelayClient({ network: opts.network });
  }

  async connect(): Promise<{ address: string; lockArgs: string }> {
    const { id, callbackUrl } = await this.client.createSession();
    this.presenter.showQr(this.client.buildAuthUrl(callbackUrl), "connect");
    this.presenter.updateStatus("awaiting-scan");
    try {
      const decoded = await this.client.pollSession(id);
      const auth = parseDecoded(AuthResultSchema, decoded);
      this.address = auth.address;
      this.presenter.updateStatus("done");
      return { address: auth.address, lockArgs: auth.pubkey };
    } catch (err) {
      this.presenter.updateStatus("error");
      throw err;
    } finally {
      this.presenter.dismiss();
    }
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    if (!this.address) {
      throw new Error("JoyIdRelaySigner: address unknown — connect() or pass address first");
    }
    const ckbTx = JSON.parse(unsigned.stringify()) as { inputs: unknown[] };
    const witnessIndexes = ckbTx.inputs.map((_, i) => i); // single-source builder: all inputs are the JoyID lock
    const challenge = await calculateChallenge(ckbTx as never, witnessIndexes);

    const { id, callbackUrl } = await this.client.createSession();
    const joyidSignUrl = this.client.buildSignUrl({ callbackUrl, challenge, address: this.address });
    const { launchUrl } = await this.client.createTxSession({ id, joyidSignUrl, preview: {} });

    this.presenter.showQr(launchUrl, "sign");
    this.presenter.updateStatus("awaiting-confirm");
    try {
      const decoded = await this.client.pollSession(id);
      const raw = parseDecoded(SignResultSchema, decoded);
      this.presenter.updateStatus("assembling");
      const signedCkb = assembleSignedCkbTx(ckbTx, raw, witnessIndexes);
      this.presenter.updateStatus("done");
      return Transaction.from(signedCkb as unknown as TransactionLike);
    } catch (err) {
      this.presenter.updateStatus("error");
      throw err;
    } finally {
      this.presenter.dismiss();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/lib/signers/joyid-relay-ckb-tx-signer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.ts apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.test.ts
git commit -m "feat(send): JoyIdRelaySigner — cross-device connect + sign orchestration"
```

---

## Task 6: QR sign-modal store + component

**Files:**
- Create: `apps/desktop/src/stores/joyid-sign.ts`
- Create: `apps/desktop/src/features/send/JoyIdSignModal.tsx`
- Test: `apps/desktop/src/features/send/JoyIdSignModal.test.tsx`

**Interfaces:**
- Consumes: `SignPhase`, `SignPreview` (Task 1), `qrcode`.
- Produces:
  - `useJoyIdSignStore` with `{ open: boolean; qrUrl: string | null; kind: "connect" | "sign" | null; phase: SignPhase; preview?: SignPreview; error?: string }` and actions `showQr`, `updateStatus`, `dismiss`, `setError`.
  - `makePresenter(): SignPresenter` — adapts the store to the `SignPresenter` contract so a signer can drive the modal.
  - `<JoyIdSignModal />` — renders the QR (via `qrcode.toDataURL`) + phase text; nothing when `!open`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useJoyIdSignStore, makePresenter } from "@/stores/joyid-sign";
import { JoyIdSignModal } from "./JoyIdSignModal";

describe("JoyIdSignModal", () => {
  it("renders nothing when closed", () => {
    useJoyIdSignStore.getState().dismiss();
    const { container } = render(<JoyIdSignModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows scan instructions when a presenter opens a connect QR", async () => {
    const presenter = makePresenter();
    presenter.showQr("https://testnet.joyid.dev/auth?x", "connect");
    presenter.updateStatus("awaiting-scan");
    render(<JoyIdSignModal />);
    expect(await screen.findByText(/scan/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/features/send/JoyIdSignModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```typescript
import { create } from "zustand";
import type { SignPhase, SignPreview, SignPresenter } from "@/lib/signers/joyid-relay/types";

interface JoyIdSignState {
  open: boolean;
  qrUrl: string | null;
  kind: "connect" | "sign" | null;
  phase: SignPhase;
  preview?: SignPreview;
  error?: string;
  showQr(url: string, kind: "connect" | "sign", preview?: SignPreview): void;
  updateStatus(phase: SignPhase): void;
  setError(message: string): void;
  dismiss(): void;
}

export const useJoyIdSignStore = create<JoyIdSignState>((set) => ({
  open: false,
  qrUrl: null,
  kind: null,
  phase: "idle",
  showQr: (qrUrl, kind, preview) => set({ open: true, qrUrl, kind, preview, phase: "awaiting-scan", error: undefined }),
  updateStatus: (phase) => set({ phase }),
  setError: (error) => set({ phase: "error", error }),
  dismiss: () => set({ open: false, qrUrl: null, kind: null, phase: "idle", preview: undefined, error: undefined }),
}));

export function makePresenter(): SignPresenter {
  const s = useJoyIdSignStore.getState();
  return {
    showQr: s.showQr,
    updateStatus: s.updateStatus,
    dismiss: s.dismiss,
  };
}
```

- [ ] **Step 4: Write the component**

```typescript
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useJoyIdSignStore } from "@/stores/joyid-sign";

export function JoyIdSignModal() {
  const { open, qrUrl, kind, phase, error } = useJoyIdSignStore();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (qrUrl) {
      void QRCode.toDataURL(qrUrl, { width: 256 }).then((d) => {
        if (active) setDataUrl(d);
      });
    } else {
      setDataUrl(null);
    }
    return () => {
      active = false;
    };
  }, [qrUrl]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" className="joyid-sign-modal">
      <h2>{kind === "connect" ? "Connect JoyID wallet" : "Approve this send"}</h2>
      {dataUrl && <img src={dataUrl} alt="JoyID QR code" width={256} height={256} />}
      <p>Scan with your phone and approve in JoyID.</p>
      <p data-testid="phase">{phaseLabel(phase)}</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "awaiting-scan":
      return "Waiting for you to scan…";
    case "awaiting-confirm":
      return "Waiting for approval on your phone…";
    case "assembling":
      return "Building the signed transaction…";
    case "done":
      return "Done.";
    case "error":
      return "Something went wrong.";
    default:
      return "";
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/features/send/JoyIdSignModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/joyid-sign.ts apps/desktop/src/features/send/JoyIdSignModal.tsx apps/desktop/src/features/send/JoyIdSignModal.test.tsx
git commit -m "feat(send): JoyID QR sign-modal store + component"
```

---

## Task 7: Wire SendPanel + SourceList to the relay signer

**Files:**
- Modify: `apps/desktop/src/features/send/SendPanel.tsx` (~line 189-196 signer construction; mount modal)
- Modify: `apps/desktop/src/features/send/SourceList.tsx` (~line 19-26 signer construction; mount modal)
- Test: existing `SourceList.test.tsx` / `SendHistory.test.tsx` stay green; add no live-network test (covered by manual smoke).

**Interfaces:**
- Consumes: `JoyIdRelaySigner` (Task 5), `makePresenter` + `JoyIdSignModal` (Task 6).
- Produces: no new exports.

- [ ] **Step 1: Swap the signer in SendPanel**

Replace the `JoyIdCkbTxSigner` import + construction (around line 190-196) with:

```typescript
      const { JoyIdRelaySigner } = await import("@/lib/signers/joyid-relay-ckb-tx-signer");
      const { makePresenter } = await import("@/stores/joyid-sign");
      // ...
      const signer = new JoyIdRelaySigner({
        network,
        address: source.address,
        presenter: makePresenter(),
      });
```

- [ ] **Step 2: Swap the signer in SourceList**

Replace `JoyIdCkbTxSigner` (line 19-26) with:

```typescript
      const { JoyIdRelaySigner } = await import("@/lib/signers/joyid-relay-ckb-tx-signer");
      const { makePresenter } = await import("@/stores/joyid-sign");
      const signer = new JoyIdRelaySigner({ network, presenter: makePresenter() });
      const { address } = await signer.connect();
```

(`network` is already in scope at `SourceList.tsx:11`; the CCC `Address`/client imports remain for deriving `joyidLockArgs`.)

- [ ] **Step 3: Mount the modal once**

Add `<JoyIdSignModal />` to `SendPanel.tsx`'s returned JSX (top level of the panel) and to `SourceList.tsx`'s returned JSX so the QR shows during connect too. Import:

```typescript
import { JoyIdSignModal } from "./JoyIdSignModal";
```

- [ ] **Step 4: Run the whole desktop suite + typecheck**

Run: `npm --workspace apps/desktop run test && npm --workspace apps/desktop run typecheck`
Expected: PASS (all existing send tests green; new tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/send/SendPanel.tsx apps/desktop/src/features/send/SourceList.tsx
git commit -m "feat(send): wire SendPanel + SourceList to JoyID cross-device relay signer"
```

---

## Task 8: Security review + manual testnet smoke

**Files:** none (review + runtime verification).

- [ ] **Step 1: Security review of untrusted-data path**

Run the `security-reviewer` agent over `joyid-relay/witness.ts`, `relay-client.ts`, `joyid-relay-ckb-tx-signer.ts`, `types.ts`. Focus:
- Relay/phone responses are parsed via Zod (`parseDecoded`) before use — confirm no raw field reaches `buildSignedTx`/`Transaction.from` unvalidated.
- The assembled signature only affects the *witness*; the tx outputs/amounts were built locally and are not taken from the phone. Confirm the phone cannot redirect funds (it signs the challenge of the locally-built tx; any tampering changes the sighash and the lock rejects it on-chain).
- Relay base URL comes from `VITE_JOYID_RELAY_URL`, not user-controlled at runtime.
- Address CRITICAL/HIGH before merge.

- [ ] **Step 2: Manual testnet smoke (PREREQ must be done)**

With the Worker deployed and `VITE_JOYID_RELAY_URL` set:
1. `npm run dev:desktop`.
2. Send → Sources → Connect: scan the QR with the JoyID mobile app, approve → a Source appears with a real `ckt1…` address; light client starts watching its lock.
3. Fund that address from the testnet faucet (≥ ~70 CKB so a recipient cell clears the 61-CKB dust floor — see CKB rule SUB-TRAP).
4. Send → pick the source → add a payee (≥ 70 CKB) → Build → approve on phone.
5. Confirm broadcast returns a tx hash; verify on a testnet explorer; Mark-confirmed → balanced JE posts.

Record the tx hash in the session memory (mirrors the "first confirmed …" memory entries).

- [ ] **Step 3: Commit any fixes from review/smoke, then update memory**

```bash
git add -A && git commit -m "fix(send): address security-review + smoke findings for relay signer"
```

---

## Task 9: Remove the dead popup signer

**Files:**
- Delete: `apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts`
- Delete: `apps/desktop/src/lib/signers/joyid-ckb-tx-signer.test.ts` (if present)

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn "joyid-ckb-tx-signer" apps/desktop/src`
Expected: no results (Task 7 removed both call sites).

- [ ] **Step 2: Delete + run suite**

```bash
git rm apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts
npm --workspace apps/desktop run test && npm --workspace apps/desktop run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(send): drop dead JoyID popup signer (replaced by relay)"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** Reported symptom (popup → about:blank) is resolved by replacing the popup signer entirely (Tasks 5/7/9); COOP conflict avoided by keeping everything in the existing renderer (no popup/opener). Connect *and* sign both covered. DER→P1363 + witnessIndexes + ≥1000-byte placeholder gotchas from the connector + CKB rule are encoded in Tasks 2/5 and Global Constraints.
- **Placeholder scan:** No TBD/TODO; every code step shows real code; the only "fill-in" is the deliberate human PREREQ block (Worker deploy + JoyID origin), which is out of code scope by nature and flagged as gating only the manual smoke.
- **Type consistency:** `SignPresenter` (`showQr`/`updateStatus`/`dismiss`) is defined in Task 1 and consumed identically in Tasks 5/6/7. `AuthResult`/`SignResult` schemas defined Task 1, used Tasks 2/5. `RelayClient` method names (`createSession`/`pollSession`/`createTxSession`/`buildAuthUrl`/`buildSignUrl`) match between Task 4 definition and Task 5 usage. `CkbTxSigner` shape unchanged, so `buildAndSend` (untouched) still type-checks.

## Open assumptions to confirm at execution

1. **`witnessIndexes = all input indexes`** relies on `buildSingleSigSend` only ever adding source-lock inputs (the source pays its own fee; no foreign-lock fee cells). Verify in `single-sig-tx-builder.ts` before relying on it; if it can mix locks, compute indexes by matching each input lock against `sourceLock` instead.
2. **`buildSignedTx` argument shapes** (`CKBTransaction` + `SignMessageResponseData`) — confirm against `node_modules/@joyid/ckb` `.d.ts` at execution; the `as never` casts in Task 2 bridge the joyid-vs-CCC nominal types and should be tightened if the real types line up.
3. **Relay endpoint contract** (`/session`, `/session/:id`, `/tx-session`, `/session/:id/callback`, `tx-launch/:id`) is taken from `joyid-ckb-connector/packages/joyid-relay`. Re-confirm paths/response keys against the deployed Worker version before Task 4 smoke.
