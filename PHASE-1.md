# Phase 1 — Embedded CKB Light Client

> Next session bootstrap. Read this before `npm install`.

## Goal

Make the Electron app **its own CKB node**. Renderer queries balance / tx history / cell search through an IPC bridge to a WASM light client running in the Electron main process. SQLite store lives under `app.getPath('userData')/light-client-store/`.

## Why this is Phase 1 (not later)

This is the defining product differentiator and the highest-risk technical component. Get it lit up first; everything after depends on it being real.

## Concrete tasks

1. **Install deps** (root + workspace):
   ```bash
   npm install
   ```
2. **Wire light client into Electron main**
   - Implement `apps/desktop/electron/main/light-client-host.ts` against `ckb-light-client-js`
   - Lifecycle: `start(network)`, `stop()`, `status()`, `tipHeader()`, `getCellsCapacity(searchKey)`, `getTransactions(searchKey)`
   - Persist store path under `app.getPath('userData')/light-client-store/<network>/`
   - Emit `light-client:sync-progress` IPC events every N seconds
3. **Expose typed IPC bridge**
   - `apps/desktop/electron/preload/index.ts` — contextBridge.exposeInMainWorld('ckb', ...)
   - `apps/desktop/src/types/ipc.d.ts` — declare global `window.ckb` types
4. **Renderer-side wrapper**
   - `apps/desktop/src/lib/light-client/ipc.ts` — thin TanStack Query-friendly wrapper
   - `apps/desktop/src/stores/sync.ts` — Zustand store fed by sync-progress events
5. **Dashboard verification gate**
   - Dashboard shows tip block height (from embedded LC) updating live, plus a placeholder for "Treasury balance" that will come online in Phase 2.
   - **Phase 1 is done when:** with no network config to third-party RPC, the app reports a synced CKB mainnet tip header and the sync-progress UI advances.

## Knowledge graph references (use graph-routing)

| Graph | What it knows |
|---|---|
| `ckb-wallet-light-client` | RFC-0044, SQLite backend, WASM bindings, storage trait |
| `ckb-wallet-neuron-port` | `light-synchronizer.ts` patterns from Neuron — sync progress, fetchPreviousOutputs, processTxsInNextBlockNumber |

Key source files to mine for patterns:
- `~/ckb-wallet/research/ckb-light-client/raw/ckb-light-client/wasm/light-client-js/src/index.ts` — JS LightClient class
- `~/ckb-wallet/research/neuron-port/raw/neuron/packages/neuron-wallet/src/block-sync-renderer/sync/light-synchronizer.ts` — orchestration reference
- `~/ckb-wallet/research/ckb-light-client/raw/lite-sqlite-findings.md` — your own benchmarks justifying SQLite default

## Pitfalls to avoid

- **Don't** start the light client in the renderer — it must run in main (filesystem access for SQLite + native module compatibility).
- **Don't** expose the raw light client instance over IPC — wrap it in a typed surface so the renderer can't accidentally pass non-serialisable references.
- **Don't** persist the store outside `app.getPath('userData')` — breaks across OS user accounts and macOS sandboxing.
- **Don't** drop the network config from the embedded mainnet/testnet JSON files in `wasm/light-client-js/` — they encode the bootnode list.
