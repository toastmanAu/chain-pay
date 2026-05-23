# Phase 2 Smoke Playbook — End-to-End Testnet Multisig

Resume-from-cold playbook for the Phase-2 In-Progress kanban item: build, sign with 2 of 3 keystores, broadcast a confirmed multisig tx on testnet.

Assumes: blake160 fix `acd1d52` is in HEAD, dev server is up (`apps/desktop/npm run dev`), and the renderer has been reloaded since the treasury-persist + clipboard-bar changes landed.

## State going in

Generated at 2026-05-21 by `scripts/make-smoke-treasury.mjs` (parity-checked against production `deriveTreasuryAddress`):

```
Treasury (2-of-3, testnet)
  Address:        ckt1qpw9q60tppt7l3j7r09qcp7lxnp3vcanvgha8pmvsa3jplykxn32sqw4amy0qryz7umdxvh0mpvugn3xyaqv75q7vlphx
  Lock args:      0xd5eec8f00c82f736d332efd859c44e262740cf50
  Code hash:      0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8 (Secp256k1MultisigV1)

Signers (in order; M=2 needed)
  1. debug/keystores/signer1.json   password=pw1   pubkeyHash=0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908
  2. debug/keystores/signer2.json   password=pw2   pubkeyHash=0x0463eacbe31265f36f1ac23d26b28755ed34a767
  3. debug/keystores/signer3.json   password=pw3   pubkeyHash=0xe4d15db3846f6ecd38b760298419450b21391e73

Full record at debug/keystores/setup.json.
```

If any of the above looks wrong, regenerate the whole set with `node scripts/make-smoke-treasury.mjs` — script is idempotent and overwrites these files.

## Funding

Faucet: <https://faucet.nervos.org/>. Paste the address above. Wait ~30 s for the next testnet block.

If the previous funding attempt landed at a pre-fix treasury address (yesterday's stuck funds), those shavings are abandoned — see memory `prefix-treasury-stuck-funds`. The address above is post-fix and spendable.

## Step-by-step

### 1. Reload renderer

If the Electron window has been open since before the treasury-store + clipboard work landed: `Ctrl+R` once. Otherwise skip.

### 2. SetupMultisig wizard

Sidebar → "Treasury" → "+ New". Fill in:

- Label: `ops-testnet` (or anything memorable)
- M = `2`, N = `3`
- Paste the 3 pubkey hashes in order:
  ```
  0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908
  0x0463eacbe31265f36f1ac23d26b28755ed34a767
  0xe4d15db3846f6ecd38b760298419450b21391e73
  ```

The wizard should derive `ckt1qpw9q60tppt7l3j7r09qcp7lxnp3vcanvgha8pmvsa3jplykxn32sqw4amy0qryz7umdxvh0mpvugn3xyaqv75q7vlphx`. If it doesn't, stop — that's a regression in `deriveTreasuryAddress` or the wizard's pubkey-hash assembly.

Save. Click into TreasuryDetail.

### 3. TreasuryDetail — confirm balance

`watchLockScript` auto-subscribes on mount. After ~1–2 blocks the balance reads the faucet amount. If it stays at 0 after >2 minutes:

- Open DevTools → Console — look for `light-client` errors
- Check `host.getCellsCapacity()` payload (should match faucet amount in shannons)
- Worst case: navigate away + back to trigger remount + resub

### 4. PayPanel — build payment

Sidebar → "Payments". The treasury picker should show `ops-testnet`. Select it.

Recipient: use one of the single-sig signer addresses from `debug/keystores/setup.json` (any of them — they're throwaway). Amount: anything ≤ funded balance minus 1 CKB. Fee rate: leave at the 1000-shannon default.

Click "Build payment". Step 5 (Transfer packet) should appear with the JSON packet visible.

### 5. Distribute the packet (via clipboard)

Click the green `⧉ copy` button in step 5 → the packet is on the OS clipboard AND in the next-open clipboard bin (auto-labeled `packet`). Verify by looking at the bottom bar — one bin should now hold the packet.

In a real flow this is where you'd hand the packet to two co-signers. For the smoke test you'll switch hats below.

### 6. SignPanel — sign with signer 1

Sidebar → "Sign". Paste the packet into "Transfer packet (JSON)". Then upload `debug/keystores/signer1.json` and enter `pw1`. Click "Sign packet". The signature appears as `0x...` (130 hex chars).

Copy the signature using its `⧉ copy` button — it lands in the next clipboard bin (auto-labeled `signature`).

### 7. SignPanel — sign with signer 2

Same as step 6, with `signer2.json` and `pw2`. The signature lands in another bin (labeled `signature`).

You should now have 3 bins filled: `packet`, `signature`, `signature`.

### 8. PayPanel — collect signatures + broadcast

Back to "Payments". Step 6 "Collect signatures" shows two textareas (M=2).

For signature 1: select slot index `1: 0x44fa9ab6…ba908` (signer 1). Click the right-aligned `paste ⇣` button → popover shows all bins → pick the signer-1 signature bin → textarea fills.

For signature 2: select slot index `2: 0x0463eacbe…a4767` (signer 2). Same paste flow with the signer-2 bin.

Click "Merge & broadcast".

### 9. Success

The BroadcastResult panel renders with the tx hash and a link to <https://pudge.explorer.nervos.org/transaction/$txHash>. Verify the tx appears in the explorer within ~30 s.

That closes the Phase-2 In-Progress item. Move on to Phase 2.5 (payroll batch).

## Failure modes to watch for

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Wizard derives a different address than expected | `multisig.ts` or `address.ts` regressed | Run `npx vitest run` — 67 tests should pass; the 8 address tests assert known good values |
| TreasuryDetail balance stays at 0 forever | scan starting block wrong, or lock not yet picked up | Check the recent tip-200 scan fix is in HEAD; try a fresh treasury entry (delete + recreate) |
| `-51 pubkey hash mismatch` on broadcast | pre-fix keystore being signed against post-fix lock | Regenerate keystores with `make-smoke-treasury.mjs` |
| "All signature slots must be filled" | A textarea has whitespace or is empty | Re-paste from the bin; trim happens automatically |
| "InvalidSecp256k1Signature" on broadcast | recovered pubkey hash doesn't match the slot you selected | Make sure each row's slot dropdown matches which signer JSON produced the sig |
| `nothing to copy` greyed copy button | the field is empty (build hasn't run yet, or sig wasn't generated) | Generate the prerequisite first |

## When this playbook updates

After Phase 2.5 (payroll batch) ships, this playbook gets a step "5a: select payees from batch" between current 4 and 5. When the comm channel (Phase 2.7) ships, steps 5–7 collapse into "send packet via channel; signatures arrive automatically as bin entries". Don't backport — make a new playbook per phase so the testnet trail stays traceable.
