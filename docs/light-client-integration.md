# Light client integration

ChainPay embeds the **CKB light client** (`@nervosnetwork/ckb-light-client-js`
WASM bundle) directly in the Electron **renderer** process. This document
explains why we embed it, why it runs in the renderer, and the runtime
ceremonies needed to make it work.

## Why embed it

The CKB light client is **the only one in our chain set** with both:

1. A WASM browser/Electron build (`@nervosnetwork/ckb-light-client-js`).
2. A storage backend small enough for desktop apps (a few MB per network).

This means ChainPay can **verify CKB mainnet state directly**, without trusting
Infura-style RPC providers. There is no equivalent for EVM today (Helios is
close but not production-stable), no equivalent for BTC at WASM-embeddable
scale, and Solana fundamentally requires a full node for trust-minimised access.

So CKB gets first-class self-custody. EVM gets best-effort RPC. That asymmetry
is the product's strongest differentiator.

## Why it runs in the **renderer**, not Electron main

The package ships a WASM bundle that requires three browser-only primitives:

- **Web Workers** (`db.worker.js`, `lightclient.worker.js`)
- **`SharedArrayBuffer`** (worker ↔ WASM data exchange)
- **A browser storage backend** (OPFS / IndexedDB via the bundled
  `ckb-light-client-db-worker`)

Electron main is a Node.js environment. None of the above work there. The
original Phase 1 plan was to run the client in main and expose an IPC bridge —
that plan was reversed when the bundle's runtime requirements became clear.

Consequence: the on-disk store path is **not** caller-controlled. The TOML
config's `[store] path` line is a no-op for the JS build; storage is opaque to
us. Acceptable for desktop because Electron's per-app IndexedDB partition gives
effectively the same isolation as a user-data file would.

## The five runtime ceremonies (none of which are documented in the package's README in one place)

### 1. Cross-Origin Isolation (COOP/COEP)

`SharedArrayBuffer` requires cross-origin isolation. Set in
`electron/main/index.ts`:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

…on every response, via `session.defaultSession.webRequest.onHeadersReceived`.
Also set in Vite's dev server `headers` so dev mode matches.

### 2. CSP must allow `blob:` workers and `wasm-unsafe-eval`

The bundle inlines workers via esbuild's `inline-worker` plugin and spawns
them as `new Worker(URL.createObjectURL(blob))`. A strict `script-src 'self'`
falls through to `worker-src 'self'` and silently refuses every worker — the
client appears to "start" but its background workers never run.

```
script-src 'self' 'wasm-unsafe-eval' blob:
worker-src 'self' blob:
```

In dev, add `'unsafe-inline'` to `script-src` for Vite's HMR preamble; CSP is
applied in `electron/main/index.ts` so dev and prod can differ from one source
of truth (the `<meta>` tag would conflict — keep it out of `index.html`).

### 3. Preload script must be CJS

`sandbox: true` in BrowserWindow webPreferences forbids ESM preload. Configure
electron-vite to emit CJS:

```ts
preload: {
  build: {
    rollupOptions: {
      output: { format: "cjs", entryFileNames: "index.js" },
    },
  },
}
```

### 4. Custom TOML config is mandatory — the WASM defaults will not work in a browser

The bundle's internal default `MainNet`/`TestNet` configs ship with **IP-only**
bootnodes on port 8114. Browsers can't open `wss://<ip>:8114/` because raw IPs
can't have valid TLS certs. Without custom config, the client connects to zero
peers and stays in "connecting" forever.

We supply our own config with the `/dns4/<host>.ckb.guide/tcp/443/wss/p2p/<id>`
bootnode list (canonical, from the package README and used by other browser
light-client wallets like Quantum Purse). See
`src/lib/light-client/network-configs.ts`.

### 5. TOML must include a stub `[rpc]` block

The embedded Rust serde deserializer in v0.5.5 fails with
`missing field 'rpc' at line N column 1` if the config omits an `[rpc]` block.
The WASM build doesn't bind any RPC port — the field is vestigial — but the
deserializer demands it. Append:

```toml
[rpc]
listen_address = "127.0.0.1:9000"
```

## Where it runs

```
Electron main process
└── BrowserWindow
      ├── sets COOP/COEP and CSP on every response (webRequest.onHeadersReceived)
      ├── opens DevTools detached in dev mode
      └── mirrors renderer console messages to stdout in dev mode

Renderer process
└── src/lib/light-client/host.ts ── LightClientHost
       │
       ├── @nervosnetwork/ckb-light-client-js · LightClient
       │     ├── lightclient.worker (sync, peers, RPC)
       │     └── db.worker (storage — OPFS / IndexedDB)
       │
       └── 5 s polling loop → snapshot listeners
              └── src/stores/sync.ts (Zustand) → Dashboard tile + Sidebar status
```

Auto-start lives at the **App** level (`src/App.tsx`), not in any feature
route. The whole UI needs sync state regardless of which page the user lands
on — coupling boot to one route mount is fragile.

## API surface (renderer-internal — no IPC)

`LightClientHost` is the only seam. Phase 2 / 2.5 features call its async
methods or subscribe to its snapshots. There is no `window.ckb.*` bridge.

| Method | Use |
|---|---|
| `start(network)` | Boot the client on `"mainnet"` or `"testnet"` |
| `stop()` | Graceful shutdown |
| `isStarted()` / `currentNetwork()` | Lifecycle introspection |
| `snapshot()` | Last-known sync state (tip, peers, lastPolledAt) |
| `onSnapshot(cb)` | Subscribe to 5 s polling snapshots; returns unsub |
| `onError(cb)` | Subscribe to async errors; returns unsub |
| `getTipHeader()` | Current chain head |
| `getPeers()` | Connected peer list |
| `getCellsCapacity(searchKey)` | Treasury balance (Phase 2) |
| `getTransactions(searchKey, order, limit, cursor)` | Tx history (Phase 2.5) |

Persistent secret key per network lives at
`localStorage["chainpay.ckb.lc.secret-key.<network>"]` — regenerated on first
launch, kept for peer identity continuity.

## Source: Phill's own benchmark (still load-bearing)

Full report at `~/ckb-wallet/research/ckb-light-client/raw/lite-sqlite-findings.md`.
Headline numbers compare the **native** RocksDB vs SQLite backends — they
justify why we picked CKB's light client (not a competitor) and why upstream
SQLite work was worth doing, even though we don't run a native build ourselves:

| Metric | RocksDB (default) | SQLite (embedded) |
|---|---|---|
| Disk usage | 132 MB | 2.4–5.8 MB |
| Binary size | ~30 MB | ~18 MB |
| Cold scan rate | ~389 blk/s | ~477 blk/s |
| Peak RSS | ~51 MB | ~44 MB |
| Correctness | ✅ | ✅ (identical balances across 24 runs) |

96–98% less disk, 23% faster cold scan, 14% less RAM, zero correctness drift.
Those wins shaped the upstream WASM build's footprint too.

## Failure modes handled (Phase 1)

| Failure | Behaviour |
|---|---|
| No internet | Tip tile stays at last-known value; `lastPolledAt` freshness in seconds visible; errors surface in tile hint |
| Polling failure | Logged via `onError` listener → Zustand `lastError`; sidebar status turns red |
| Worker/WASM init failure | `start()` rejects; `useSyncStore.startCkb` traps and stores `lastError` |
| No peers attached | Status shows "connecting" instead of "running" until peer count > 0 |

## Failure modes deferred to later phases

| Failure | When |
|---|---|
| Storage corruption | Phase 2 — when treasury data depends on the store, we need a "reset and re-sync" UX |
| Slow first sync ETA | Phase 2 — first-time treasury setup is when this matters |
| Process crash auto-restart | Not applicable: the client runs in the same renderer process as the UI; a crash takes the window with it. Renderer-level error boundary + soft restart if revisited |
| Bootnode list drift | If `*.ckb.guide` bootnodes go offline, the config in `network-configs.ts` needs refreshing from upstream |

## Optional: optimisations to port

Phill's two upstream-pending PRs (see lite-sqlite-findings.md § 5) target the
native SQLite backend and don't affect the WASM build directly. If they land
and the WASM `db-worker` adopts equivalent changes (or if we switch to a
future native binding), reconsider.
