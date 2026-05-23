# Phase 2.5 Smoke Playbook — Payroll Batch End-to-End

Resume-from-cold playbook for the Phase-2.5 payroll-batch path: define payees, build a batch from them (with live FX), sign with 2 of 3 keystores, broadcast a confirmed multisig batch tx on testnet.

This is the *payroll* analog of `docs/phase-2-smoke-playbook.md` — same multisig underneath, but driven through the Employees → PayrollBatch lifecycle instead of typing recipients by hand. If anything here regresses, run the Phase-2 playbook first to isolate whether the failure is in the bare multisig path or in the payroll wrapper.

**Assumes:** witness-padding fix is in HEAD (commit landed 2026-05-23 with regression test `pads tx.witnesses to match tx.inputs.length so on-chain & local digests agree`), draft persistence is in HEAD (`PayrollBatch.txBytes` + `sighashDigest` + `partialSigs`), CSP allows `http:` in `connect-src`, dev server is up (`cd apps/desktop && npm run dev`).

## State going in

Reuse the same treasury and keystores from the Phase-2 smoke playbook:

```
Treasury (2-of-3, testnet)
  Address:        ckt1qpw9q60tppt7l3j7r09qcp7lxnp3vcanvgha8pmvsa3jplykxn32sqw4amy0qryz7umdxvh0mpvugn3xyaqv75q7vlphx
  Lock args:      0xd5eec8f00c82f736d332efd859c44e262740cf50
  Code hash:      0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8 (Secp256k1MultisigV1)

Signers (M=2 needed)
  1. debug/keystores/signer1.json   password=pw1   pubkeyHash=0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908
  2. debug/keystores/signer2.json   password=pw2   pubkeyHash=0x0463eacbe31265f36f1ac23d26b28755ed34a767
  3. debug/keystores/signer3.json   password=pw3   pubkeyHash=0xe4d15db3846f6ecd38b760298419450b21391e73
```

Verify with `node scripts/verify-keystores.mjs` if you have any doubt; it'll decrypt each, derive the blake160, and compare to `setup.json`.

## Funding

After the Phase-2 milestone (`0x4e66d1…`) and Phase-2.5 milestone (`0x69ebf7…`) the treasury balance should be ~`96,791 CKB` in the change cell at `0xd5eec8f0…cf50`. If you need more, top up via <https://faucet.nervos.org/> with the treasury address above.

## Step-by-step

### 1. Settings — confirm broadcast RPC

Sidebar → Settings → **Transaction broadcast RPC URL**: `http://192.168.68.134:8114` (or your own node). The CSP fix from this session permits plain `http:` so a LAN node works. The default LC `sendTransaction` does not propagate reliably — see memory `lc-broadcast-into-the-void`.

### 2. Employees — add at least one payee

Sidebar → **Employees** → fill the form once per payee. Smoke-test triplet (uses the throwaway signer addresses as wallets — you control the keys, so even if a payroll tx fires the funds aren't lost):

| Display name | Salary | Currency | Chain | Wallet address |
|---|---|---|---|---|
| Alice (test) | 50.00 | USD | CKB testnet | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2yl2dtdldv6jp87hkpd8p3a8n77346jzq2wz6r9` |
| Bob (test) | 50.00 | USD | CKB testnet | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgyv04vhccjvhek7xkz85nt9p64a562wecfy2aal` |
| Carol (test) | 50.00 | USD | CKB testnet | `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq0y69wm8pr0dmxn3dmq9xzpj3gtyyu3uuck5mx22` |

For smoke purposes, stick to USD across all three — the JPY 0-decimal handling is a backlog item (not yet implemented; today everything is stored as 2-decimal `minor`).

### 3. Payments — load payees + build the batch

Sidebar → **Payments**. Treasury picker → select `ops-testnet` (or whichever label is on the post-blake160-fix treasury). Confirm the displayed address matches the lock args in §0 above.

Click **`+ load from payees`** in the recipients section. Tick all three payees, confirm. Expected sequence inside ~2s:

1. PayeePicker closes
2. One CoinGecko request fires for `usd` (batched by unique currency)
3. `FxSnapshotPanel` renders with `1 CKB = X USD · CoinGecko · HH:MM:SS`
4. Each recipient row's `amount CKB` auto-populates from `salary / rate`
5. Each row internally carries its `fxRate` — visible later in `PayrollBatch.lines[i].fxRate`

Fee rate: leave the `1000` default. Label: blank is fine (it'll auto-label as `Batch YYYY-MM-DD`).

Click **`Build payment`**. Expected:

- Step 5 (Transfer packet) renders with the JSON
- A new `calculated`-state batch appears in PayrollBatches (sidebar → Payroll Batches → top of list)
- Tx now carries 2 inputs from yesterday's treasury cells (or 1 if the treasury has a single fat cell)

`★ Why the batch is created now and not later:` the persisted batch's `txBytes` IS the source of truth. From this point forward, navigating away and resuming Resume on the batch card hydrates this exact tx — no rebuild, no FX re-fetch, no capacity drift. That's how a real operator workflow (build now, sign hours later via comm channel) survives a window close.

### 4. SignPanel — produce signer 1's sig

Click the **`⧉ copy`** button on step 5 → packet hits the OS clipboard AND lands in a `packet` clipboard bin.

Sidebar → **Sign**. Paste the packet into the textarea. Upload `debug/keystores/signer1.json`. Password: `pw1`. Click **`Sign packet`**. The signature appears as `0x…` (130 hex chars).

**Important UX caveat** (known issue, backlog): `paste ⇣` popovers don't distinguish between today's and yesterday's `signature` bins because they share the same label. If you've previously signed something this session, **manually select + Ctrl+C the sig text from the textarea**, then Ctrl+V it directly into PayPanel's slot. Don't trust the clipboard bin popover unless you've cleared old signature bins first.

### 5. SignPanel — produce signer 2's sig

Same as step 4 with `signer2.json` / `pw2`. Manually copy the resulting sig (Ctrl+C).

### 6. PayPanel — paste + broadcast

Two routes here, both valid:

**Route A — stay on the Payments tab.** The PayPanel state is still alive from step 3. Step 6 textareas await two sigs. Slot 1 (claimed hash `0x44fa9ab6…`) ← signer-1 sig. Slot 2 (claimed hash `0x0463eacb…`) ← signer-2 sig. Persistence kicks in: each paste writes to `batch.partialSigs` immediately — visible as `1/2 sigs collected` then `2/2` on the batch card in PayrollBatches.

**Route B — close the window, come back, resume.** This is the *real* workflow (the comm-channel scenario). Close the Electron window or refresh (Ctrl+R). Reopen → PayrollBatches → click **`Resume`** on the calculated batch. PayPanel mounts at step 5 with the frozen tx restored, packet re-rendered, FX values unchanged. Paste the two sigs into slots 1 and 2. This is the path that's broken without draft persistence and now works.

Click **`Merge & broadcast`**. Expected:

1. Pre-broadcast assertion runs (cfg ↔ address ↔ witness consistency) — must pass silently
2. Diagnostic dump to console: `[chainpay] tx inputs to broadcast` + `window.__chainpay_debug` populated
3. Batch transitions `calculated → approved` (rollback-safe if next step throws)
4. `broadcastTransaction` via Settings RPC URL
5. Batch transitions `approved → broadcasted` with `pendingTxId` stamped
6. BroadcastResult panel renders with tx hash + explorer link

### 7. Verify on chain

Open the explorer link (or copy the tx hash and visit `https://pudge.explorer.nervos.org/transaction/<hash>`). Expected within ~30s:

- Status: `committed`
- Inputs: typically 2 (treasury change cells from prior milestones), 1 if the treasury has a single cell large enough
- Outputs: 3 payee cells + 1 change cell back to the treasury
- Cycles: ~3M (multisig verifies once per script group, not per input — so cycle cost is dominated by the multisig itself, not the input count)

Phase 2.5 milestone reference tx: `0x69ebf739fb40ca0f205a16394c506d79f2775b44051826c8d17c725cb1a3b4e1` (committed in block 21,176,012, 3 payees + change, 3,002,073 cycles).

## Failure modes to watch for

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `0x` after `+ load from payees` (no FX auto-fill) | CoinGecko fetch failed; check console for the actual error | Click `re-fetch` on FxSnapshotPanel; or enter `amount CKB` manually (will skip the fxRate lineage on those rows) |
| Build fails with "no cells found for this treasury" | Treasury isn't funded, or LC hasn't synced past funding block | Faucet → wait 30s → re-check the balance tile; also memory `lc-broadcast-into-the-void` |
| "signature for slot N recovers to 0x…, not …" | Pasted sig is over a different digest — either stale clipboard bin or a prior build's sig | Clear the slot textarea explicitly (select-all + delete), re-sign fresh, paste directly without using the bin popover |
| `-52` (ERROR_VERIFICATION) on chain | (Should not happen post-fix.) If it does: `tx.witnesses.length !== tx.inputs.length` regressed in `buildPaymentSkeleton`. Run `npx vitest run -- tx-builder` and confirm the "pads tx.witnesses" test still passes |
| `-51` (ERROR_PUBKEY_BLAKE160_HASH) on chain | Sigs valid for cfg but cfg doesn't match the actual cells' lock — see Treasury Detail to confirm address, or memory `prefix-treasury-stuck-funds` |
| CSP error `Refused to connect to 'http://…'` | Old CSP without `http:` in `connect-src`. Restart the dev server after pulling `electron/main/index.ts` updates |
| "Treasury config drift" pre-broadcast assertion fires | `cfg.pubkeyHashes` order changed since the wizard. Re-create treasury from `setup.json` |
| Window stuck at "starting…" on Dashboard tile | Renderer's `useSyncStore` desync'd from LC host (common after HMR + main-process restart) | Ctrl+R to re-init |
| PayrollBatches `→ broadcasted` button "claims" success but no tx on chain | That button is a *state-machine transition only*, not a broadcast. Real broadcast happens via PayPanel's `Merge & broadcast`. UI confusion, not a bug. |

## What this playbook validates

Compared to the Phase-2 playbook, this run additionally exercises:

- Persisted `usePayeesStore` (CRUD + bigint-safe `salaryFiat.minor`)
- `usePayrollBatchesStore` with state machine transitions and persistence
- N-to-many tx builder
- CoinGecko FX snapshot + `fiatToCkbShannons` precision math
- PayPanel ↔ PayrollBatch lifecycle wire-up
- Multi-input multisig digest (the witness-padding fix)
- Draft persistence (txBytes + sighashDigest + partialSigs survives navigation/refresh)
- Resume button on PayrollBatches
- Full CSP / broadcast-RPC path with HTTP allowance

## When this playbook updates

After Phase 2.7 (CEMP-PQ comm channel) ships, steps 4–5 collapse from "copy packet, paste signature" into "send packet via channel; signatures arrive automatically as bin entries / inbox events". Don't backport — make a new playbook (`phase-2.7-smoke-playbook.md`) so the testnet trail stays traceable phase-by-phase.

After Phase 3 (EVM / Safe) ships, this CKB playbook stays as-is — Safe gets its own.
