# Phase 1 — Embedded CKB Light Client

> **Status: complete (2026-05-20).** Verification gate met: dashboard shows live
> mainnet sync from an embedded WASM light client, no third-party RPC configured.
> Peers attach within ~30 s on first launch; first chain root proof follows
> shortly after.

## Goal

Make the Electron app **its own CKB node**. The renderer runs the
`@nervosnetwork/ckb-light-client-js` WASM bundle to verify mainnet state
directly. No Infura-style RPC trust assumption.

## What landed

| Piece | File |
|---|---|
| WASM light client wrapper + 5s polling loop | `apps/desktop/src/lib/light-client/host.ts` |
| Singleton accessor | `apps/desktop/src/lib/light-client/client.ts` |
| Mainnet + testnet TOML configs (WSS bootnodes + required `[rpc]` block) | `apps/desktop/src/lib/light-client/network-configs.ts` |
| Zustand sync store fed by the host's snapshot listener | `apps/desktop/src/stores/sync.ts` |
| App-level auto-start (boots before any route mounts) | `apps/desktop/src/App.tsx` |
| Dashboard tile + sidebar status indicator | `apps/desktop/src/features/dashboard/Dashboard.tsx`, `components/layout/Sidebar.tsx` |
| Session-level CSP, COOP/COEP, DevTools auto-open in dev, renderer→stdout console mirror | `apps/desktop/electron/main/index.ts` |
| CJS preload output (required by `sandbox: true`) | `apps/desktop/electron.vite.config.ts` |
| Per-network persistent secret key | `localStorage["chainpay.ckb.lc.secret-key.<network>"]` |

## Architectural decision — **light client runs in the renderer, not Electron main**

The original Phase 1 plan called for the light client to run in Electron main
with an IPC bridge to the renderer. That was reversed.

`@nervosnetwork/ckb-light-client-js@0.5.5` ships a WASM bundle that **requires**
Web Workers, `SharedArrayBuffer`, and a browser storage backend (the bundled
`ckb-light-client-db-worker` writes to OPFS / IndexedDB). Electron main is
Node.js — none of those primitives exist there.

Trade-off accepted: we lose direct filesystem control over the store (no custom
path under `app.getPath('userData')`). Electron's per-app IndexedDB partition
gives effectively equivalent isolation.

## The five ceremonies needed to make this run

These are not obvious, none of the WASM client's README mentions them all
together, and each was a separate debugging hour. Capture for future Phill /
anyone porting:

### 1. Cross-Origin Isolation headers (COOP/COEP)

`SharedArrayBuffer` requires the document to be cross-origin isolated. Set on
every response from `session.defaultSession.webRequest.onHeadersReceived`:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

### 2. Content Security Policy must allow `blob:` workers and `wasm-unsafe-eval`

The WASM bundle inlines its workers via esbuild's `inline-worker` plugin and
spawns them as `new Worker(URL.createObjectURL(blob))`. A strict
`script-src 'self'` (which falls through to `worker-src 'self'`) silently
refuses every worker — the client "starts" but its background workers never run.

```
script-src 'self' 'wasm-unsafe-eval' blob:
worker-src 'self' blob:
```

In dev, add `'unsafe-inline'` to `script-src` for Vite's HMR preamble; this is
stripped in production builds. CSP is set at the Electron session level (not the
meta tag) so dev and prod can differ.

### 3. Preload must be CJS (not ESM) because `sandbox: true`

Sandboxed preload scripts don't support ESM. Configure
`electron.vite.config.ts` preload output:

```ts
output: { format: "cjs", entryFileNames: "index.js" }
```

And reference `preload/index.js` (not `.mjs`) from the BrowserWindow webPreferences.

### 4. Custom TOML config is mandatory — the WASM defaults won't work in a browser

The WASM bundle's internal default `MainNet` / `TestNet` configs ship with
**IP-only** bootnodes (port 8114). Browsers can't open WSS to a raw IP (no valid
TLS cert), so zero peers attach. We must supply our own config with the
`/dns4/<host>.ckb.guide/tcp/443/wss/p2p/<peer-id>` bootnode list — the same one
documented in the package README.

### 5. The TOML must include a stub `[rpc]` block

The embedded Rust serde deserializer in v0.5.5 fails with
`missing field 'rpc' at line N column 1` if the config omits an `[rpc]` block.
The WASM build doesn't bind any RPC port — the field is vestigial — but it must
parse. Add:

```toml
[rpc]
listen_address = "127.0.0.1:9000"
```

## Why this is Phase 1 (not later)

Self-custody read access is the defining product differentiator and the highest-
risk technical component. Getting it lit up first means every downstream feature
(treasury balance reads, tx history, payment confirmations) inherits trust-
minimised state for free.

## Verification gate

With **no** `CKB_REMOTE_RPC_URL` set:

1. `npm run dev:desktop` launches the Electron app.
2. Sidebar "CKB light client" status: `starting` → `connecting` → `running`.
3. Dashboard "CKB tip block" tile shows a live mainnet height (~16M+ as of
   2026-05-20). Peer count > 0. Last-polled timestamp ticks every ~5 s.

## Dev affordances kept around

- **`mainWindow.webContents.openDevTools({ mode: "detach" })` in dev mode** —
  saves "where's the console" hunting on every iteration.
- **Renderer→stdout console mirror** in the main process forwards
  `console-message` events to the terminal. Without it, all renderer errors
  (including silent CSP refusals) are invisible to anyone running
  `npm run dev:desktop` from a shell.

## What Phase 1 does **not** do

- No CKB transaction construction (Phase 2).
- No treasury balance reads beyond the tip header (Phase 2 wires
  `getCellsCapacity` into a treasury detail screen).
- No tx history / payment confirmation watcher (Phase 2.5).
- No reset / re-sync UI for storage corruption recovery.

## Next: Phase 2 — CKB multisig treasury

See `docs/mvp-roadmap.md` § Phase 2. The stubs at
`apps/desktop/src/lib/chains/ckb/multisig.ts` are the entry points.
