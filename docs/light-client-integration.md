# Light client integration

ChainPay embeds the **CKB light client (SQLite backend)** directly in the Electron main process. This document explains why, where it runs, and how Phase 1 wires it up.

## Why embed it

The CKB light client is **the only one in our chain set** with both:

1. A WASM browser/Electron build (`ckb-light-client-js`).
2. A SQLite storage backend small enough for desktop apps (2.4–5.8 MB store, ~3 MB WASM).

This means ChainPay can **verify CKB mainnet state directly**, without trusting Infura-style RPC providers. There is no equivalent for EVM today (Helios is close but not production-stable), no equivalent for BTC at WASM-embeddable scale, and Solana fundamentally requires a full node for trust-minimised access.

So CKB gets first-class self-custody. EVM gets best-effort RPC. That asymmetry is the product's strongest differentiator.

## Source: Phill's own benchmark

Full report at `~/ckb-wallet/research/ckb-light-client/raw/lite-sqlite-findings.md`. Headline:

| Metric | RocksDB (default) | SQLite (embedded) |
|---|---|---|
| Disk usage | 132 MB | 2.4–5.8 MB |
| Binary size | ~30 MB | ~18 MB |
| Cold scan rate | ~389 blk/s | ~477 blk/s |
| Peak RSS | ~51 MB | ~44 MB |
| Correctness | ✅ | ✅ (identical balances across 24 runs) |

96 – 98 % less disk, 23 % faster cold scan, 14 % less RAM, zero correctness drift. SQLite is unambiguously the right choice for desktop / mobile / embedded.

## Where it runs

```
Electron main process
└── light-client-host.ts ── owns LightClient instance ── SQLite store
       │                                                  └── app.getPath('userData')/light-client-store/<network>/
       │
       ▼ ipcMain.handle(...)
   Electron preload (contextBridge)
       │
       ▼ window.ckb.*
   Renderer (React)
       └── src/lib/light-client/ipc.ts ── TanStack Query wrapper
```

The renderer is sandboxed. It can call `window.ckb.tipHeader()` but cannot reach the SQLite file, the WASM instance, or the network sockets directly.

## IPC surface

| Renderer call | Main handler | Use |
|---|---|---|
| `window.ckb.start(network)` | `lightClient.start(network)` | Boot the light client |
| `window.ckb.stop()` | `lightClient.stop()` | Graceful shutdown |
| `window.ckb.status()` | `lightClient.status()` | `{ started, network }` |
| `window.ckb.tipHeader()` | `lightClient.tipHeader()` | Current chain head |
| `window.ckb.getCellsCapacity(searchKey)` | `lightClient.getCellsCapacity(searchKey)` | Treasury balance |
| `window.ckb.getTransactions(searchKey, order, limit, cursor)` | `lightClient.getTransactions(...)` | Tx history |
| `window.ckb.onSyncProgress(cb)` | event `ckb:sync-progress` | Live sync indicator |

Subscribe-once via `onSyncProgress` returns an unsubscribe function — store it in a Zustand store, call it on unmount.

## Phase 1 implementation order

1. Install deps (`ckb-light-client-js` + peer deps).
2. Replace `LightClientHost` stubs with real `ckb-light-client-js` calls (see `light-client-host.ts`).
3. Pass the SQLite store path via `app.getPath('userData')/light-client-store/<network>/`.
4. Pipe sync progress: poll `tipHeader` + connected peer count, emit `sync-progress` events every 2–5 s.
5. Renderer subscribes via `window.ckb.onSyncProgress` (already wired in `src/stores/sync.ts`).
6. Dashboard's "CKB tip block" tile starts updating live — this is the verification gate.

## Optional: optimisations to port

Phill's two upstream-pending PRs (see lite-sqlite-findings.md § 5):

1. **WITHOUT ROWID + redundant index removal** — disk + lookup speed
2. **Multi-block transaction batching** — sync speed on flash

If either lands in `ckb-light-client-js` before Phase 1 starts, prefer the patched version. Otherwise the default v0.5.5-rc1+ build is fine.

## Failure modes to handle (Phase 1)

| Failure | UX |
|---|---|
| No internet | Sync indicator shows "offline", balance reads return last-known cached value with timestamp |
| Light client process crash | Auto-restart with backoff; show toast "light client restarted" |
| Store corruption | Detect on open; offer "reset store and re-sync" (data is reconstructable from network) |
| Slow first sync | Progress UI shows blocks-per-second and ETA based on rolling average |
