# ChainPay Comm Channel — On-chain Encrypted Signature Relay

**Status:** Design, Phase 2.7 candidate. Not in flight. Phase 2.5 (payroll batch) ships first.

**Owner:** Phill. **Draft:** 2026-05-21.

**Superseding transport candidate**: `~/ecms/cemp-pq/` — Phill's already-in-progress CKB Post-Quantum Encrypted Messaging Protocol. The body of this doc was drafted before that protocol was visible; large chunks below (PSK ceremony, AES-256-GCM under HKDF, secp256k1 comm wallet, "PQC encryption is v3") are obsoleted by CEMP-PQ. The structural decisions that survive: comm-key/multisig-key separation invariant, capacity-funded comm wallet, two-tier message + notification cells (CEMP-PQ already implements this). Treat sections below as historical reasoning; the actual implementation should be a thin ChainPay adapter over CEMP-PQ's `CEMPTransactionBuilder` and `MLDSASigner`. See addendum at the bottom of this file for the CEMP-PQ-shaped flow.

## What this is

An on-chain, encrypted, peer-to-peer messaging layer that eliminates the manual email/messenger step from the multisig signing flow. Each ChainPay install holds a "comm wallet" — a small CKB account used purely for routing encrypted payloads to other ChainPay installs via cells. The treasury multisig keys never appear on this path; the comm wallet only carries enough capacity to fund cell ops.

End-state operator UX:

1. Operator builds tx → ChainPay encrypts the transfer packet under each co-signer's session key → broadcasts N "send" cells (one per signer's comm address).
2. Each signer's light client observes a new cell at its comm address → app surfaces a notification → user enters the pairing password → packet decrypts → user signs with their ckb-cli keystore (unchanged) → app encrypts the signature → broadcasts a "reply" cell to the operator's comm address.
3. Operator's light client observes M reply cells → app decrypts each → assembles the multisig witness → broadcasts the actual treasury tx.

Zero centralized infrastructure, durable delivery (CKB inherits the guarantees), attributable but pseudonymous (lock script proves which comm address sent each cell), and quantum-resistant for confidentiality (AES-256-GCM stays safe under Grover; PQC sig schemes are a separate v2 axis).

## Why this matters

Phase 2 ships a working M-of-N flow but requires operators to email/messenger packets and signatures between human signers — out-of-band, easy to lose, no audit trail. The chain itself is the obvious carrier: every CKB instance already has a light client, every cell already has a `data` field, and `watchLockScript` already delivers cell-arrival events.

The cost is real but bounded: a relay round-trip is 2M cells per signing session (one packet-out + one signature-back per signer in an M-of-N), each consuming ~1000 shannons in fees plus ~70 CKB of capacity locked while the cell exists (refundable on consumption). At today's testnet rates the entire flow costs less than 0.01 CKB in fees.

## Core misconceptions, addressed up front

- **"Destroy the cell after read = data gone."** No. Consuming a cell removes it from the live UTXO set, but the transaction that created it — including `output.data` — is permanently in every block forever. Encryption does all the privacy work; cell consumption is just capacity hygiene.
- **"Use ML-DSA / SPHINCS+ to encrypt."** ML-DSA (Dilithium) and SPHINCS+ are **signature** schemes, not encryption. For PQC-grade confidentiality we'd use a KEM like ML-KEM (Kyber). For ChainPay's use case, AES-256-GCM with HKDF is sufficient (256-bit symmetric ≈ 128-bit post-quantum effective strength under Grover, still infeasible).
- **"Comm wallet = signing key."** Strictly no. If a single key controls both relay and multisig signing, comm-key theft = treasury compromise. Comm key blast radius must stay scoped to "dust spam attacker" — kept separate by construction.

## Architecture

```
┌──────────────────┐         ┌─────────────────────┐         ┌──────────────────┐
│ Operator install │         │      CKB chain      │         │ Signer install   │
│                  │         │                     │         │                  │
│ comm key A ───►──┼──cell──►│  to comm B          │──cell──►│──◄ comm key B    │
│ (secp256k1,      │         │  data = E(K_AB, m)  │         │  (secp256k1,     │
│  rotated per     │         │                     │         │   rotated)       │
│  session)        │         │  to comm A          │◄──cell──┤                  │
│                  │         │  data = E(K_AB, σ)  │         │                  │
│ multisig key ✗   │         │                     │         │ multisig key ✗   │
│ (loaded transient)         │                     │         │ (loaded transient│
│  per sign only)  │         │                     │         │  per sign only)  │
│                  │         │                     │         │                  │
│ LightClient ◄────┼─────────┤   watchLockScript   ├─────────┼─► LightClient    │
│ watches comm A   │         │   per-install lock  │         │  watches comm B  │
└──────────────────┘         └─────────────────────┘         └──────────────────┘
```

**Two distinct key surfaces per install:**

- **Comm key** — secp256k1, generated on first run, persisted in renderer state (same Zustand+localStorage pattern as treasuries). Funded with ~5 CKB. Rotated regularly (see Rotation below).
- **Multisig signer key** — ckb-cli keystore on the user's disk. Loaded transiently per sign, never persisted by ChainPay. Unchanged from Phase 2 today.

**Refusal invariant:** the app MUST refuse to add a comm-address to the address book if it matches the pubkey hash of any known multisig signer for any active treasury. Enforce in `addPeer()`.

## Envelope format

Cell `output.data` carries the message envelope. Molecule-tagged for future-proofing.

```
Envelope (binary, length-prefixed bytes):
  | version    (1 byte)   | currently 0x01
  | kind       (1 byte)   | 0x01=packet 0x02=signature 0x03=ack
  | sender_addr_hash (20) | blake160 of sender's session comm pubkey
  | iv         (12 bytes) | random per message
  | ciphertext (variable) | AES-256-GCM(K, iv, plaintext)
  | tag        (16 bytes) | GCM auth tag
```

Plaintext for `kind=packet`:

```json
{
  "txHash": "0x…",                 // operator's stable id for this signing session
  "treasuryAddress": "ckt1q…",
  "expiresAt": 1747900000,         // epoch s — receivers reject after this
  "packet": "<existing transfer packet JSON>"
}
```

Plaintext for `kind=signature`:

```json
{ "txHash": "0x…", "slotIndex": 0, "signature": "0x…" }
```

Plaintext for `kind=ack`:

```json
{ "txHash": "0x…", "received": true }
```

## Pairing & session key

The shared symmetric key `K_AB` between operator A and signer B is derived from a Pre-Shared Key (PSK) exchanged once during pairing. The PSK exchange is the single most security-sensitive operation.

```
PSK (32 random bytes) ─── pairing ceremony (QR scan or copy/paste both directions) ───┐
                                                                                       │
K_session = HKDF-Extract-and-Expand(                                                   │
    salt   = pair_id || A_pubkey || B_pubkey,                                          │
    ikm    = PSK,                                                                      │
    info   = "chain-pay/comm/v1",                                                      │
    length = 32                                                                        │
)
```

Pairing UI flow:

1. User A clicks "Pair with peer" → app generates fresh PSK + displays as QR + 4-word safety phrase derived from `HKDF(PSK, "safety-word")[:4 words]`.
2. User B scans QR → enters same safety phrase to confirm match → app stores `{ peerName, peerCommAddress, PSK, pairedAt }` in encrypted-at-rest peer book.
3. Both apps now share `K_session`. No on-chain handshake needed. If trust later breaks, either side can issue a `kind=revoke` message (or just delete the entry).

**Critical**: the pairing UI must FORCE the safety-phrase confirmation. Skipping it means the QR could have been substituted by a screen-recording-MITM. The 4-word phrase is the human-verifiable shared-state check.

## Address rotation

A persistent single comm address links every signature relay back to the same install — terrible privacy. Rotation is built in.

Two schemes available, both deterministic so the counterparty can predict the next address without an additional handshake.

**A. HKDF chain (default for v1):**

```
addr_0 = secp256k1_pubkey_from_priv(HKDF(PSK || "/comm/", info="addr/0"))
addr_N = secp256k1_pubkey_from_priv(HKDF(PSK || "/comm/", info=f"addr/{N}"))
```

Both sides increment `N` per message. The chain is implicit; there's no on-chain registry of which address is "current". Loss of sync is recoverable: the receiver scans the next K addresses (K=16) for live cells.

**B. BIP32-style hierarchical (v2, deferred):**

Reuse industry pattern. Heavier dependency footprint (need a proper HD-wallet derivation lib that handles secp256k1 hardened/normal child keys). Defer until pairing & rotation prove out under A.

**Privacy property** scheme A delivers: an external observer who does NOT have the PSK sees an unconnected stream of secp256k1 lock cells, indistinguishable from random wallet activity. An observer who DOES have the PSK (or who has compromised either install) can re-link all rotated addresses — so PSK secrecy is the privacy boundary.

**Limit**: rotation does NOT defeat traffic analysis against a network observer who can see the renderer's outbound HTTPS to peers (light-client P2P). For that you'd want Tor or i2p — out of scope for v1.

## Forward secrecy

v1 (this design): **no per-message FS**. PSK compromise reveals all historical messages.

v2 (planned): X3DH-style double ratchet — each message advances both a sending and receiving chain key. Same pattern Signal uses. PSK becomes the long-term identity; ephemeral keys live and die per message. Cost: ~3x the protocol surface to reason about.

Decision: ship v1 first. PSK rotation (manual re-pair) is the operator's lever until FS lands.

## Cell lifecycle & capacity

```
Send (operator side):
  build tx with outputs[0] = {
    capacity: 70 CKB minimum,
    lock:     { code_hash: SECP256K1_BLAKE160, args: recipient_addr },
    type:     null,                              // no type script in v1 (see open Q)
    data:     <envelope bytes>
  }
  broadcast via host.broadcastTransaction(tx)

Receive (signer side):
  host.watchLockScript({ code_hash: SECP256K1, args: own_addr_N }, fromBlock: lastSeenBlock)
  on poll (POLL_INTERVAL_MS):
    cells = host.listCellsForLock(own_addr_N)
    new_cells = cells - already_seen
    for cell in new_cells:
      decrypt(cell.data) → surface to user

Consume (after decryption):
  tx with input[0] = cell, output[0] = own_addr_(N+1) with refund_capacity - tx_fee
  broadcast — frees capacity, rotates address
```

Capacity per message: ~70 CKB locked while cell lives; refunded on consume. Steady state for a 2-of-3 signing session = 4 cells × ~70 = ~280 CKB locked briefly, but the comm wallet only needs to *cover* this if running multiple sessions in parallel.

Initial fund-comm-wallet UX: prompt user to fund the freshly-generated comm address with ~50 CKB on first install. Lower bound: 1 cell of capacity + tx fees ≈ ~70.001 CKB.

## Implementation modules

Five modules, ordered by dependency:

```
1. comm-key             — generate/persist secp256k1 keypair; HKDF rotation chain
2. envelope             — encrypt/decrypt/encode/decode molecule envelope (AES-256-GCM + HKDF)
3. peer-book            — Zustand store, persisted: { name, peerAddress, PSK, pairedAt }
4. pairing-ui           — QR display + scan + safety-phrase confirm
5. comm-channel         — high-level send(peer, plaintext) + onReceive(handler) glue
                          uses LightClientHost.broadcastTransaction + listCellsForLock
6. wiring               — PayPanel "Send to signers" button; SignPanel "Inbox" UI; consume-after-decrypt
```

Each module: <300 lines, unit-tested, isolated. Reuse existing patterns:

- comm-key persist = treasury.ts / clipboard.ts pattern
- peer-book persist = treasury.ts pattern
- envelope tests = ckb-secp256k1.test.ts pattern (15 tests in that file as reference for the bar)
- comm-channel uses `lightClient()` singleton — already wired

## Dependencies & licensing

| Dep | Use | License | Already in tree? |
|-----|-----|---------|------------------|
| `@noble/ciphers/aes` | AES-256-GCM | MIT | yes (used in `make-test-keystore.mjs`) |
| `@noble/hashes/hkdf` | session-key derivation | MIT | yes |
| `@noble/curves/secp256k1` | comm-key gen | MIT | yes |
| `qrcode` | QR display | MIT | new — small |
| `jsqr` | QR scan (via webcam) | Apache-2.0 | new — small |
| optional `@ckb-ccc/core` (Cell, OutPoint) | tx construction | MIT | yes |

Zero new heavy deps. All crypto comes from `@noble/*` which is already in the desktop bundle.

## Threat model

| Attacker | Capability | Mitigation |
|----------|------------|------------|
| Network observer (passive) | sees encrypted ciphertext on chain forever | AES-256-GCM is computationally infeasible to brute-force |
| Network observer (active, post-quantum) | as above, but with a CRQC | AES-256 → ~128-bit effective; still infeasible |
| Compromised counterparty install | has the PSK, can decrypt all past + future messages with that peer | No defense in v1 (this is FS scope, v2). Rotate PSK manually. |
| Compromised local install | has comm key, PSK book, treasury list | Out-of-scope (defense at OS level; multisig keys still held off-app). Comm key blast radius = dust spam. |
| MITM during pairing | substitutes QR mid-display | 4-word safety phrase comparison defeats this if users do it. App must NOT allow skip. |
| Spam to receiver address | floods inbox with junk cells | v1: rate-limit per sender. v2: require small "postage" output back to sender. |
| Coercion of signer | as today (signer signs against their will) | Out of scope. ChainPay does not solve the human problem. |

## Open questions for plan session

1. **Type script — yes or no in v1?** A custom type script could enforce envelope shape on-chain (reject malformed cells before they hit the inbox). Adds a contract deploy + cell-dep wiring. Probably defer until v2 unless spam mitigation needs it.
2. **Polling interval vs. push delivery.** Current `POLL_INTERVAL_MS` is whatever the light-client default is. For interactive UX (signer sees notification within ~5s) this is acceptable. Tighten only if user-perceived latency becomes a complaint.
3. **Cross-network safety.** What stops a testnet-paired comm channel from being replayed on mainnet? Bind the HKDF salt to `chain_id` ("ckb:testnet" vs "ckb:mainnet"). Done.
4. **PQC comm-key migration path.** When `ckb-mldsa-lock` stabilizes (currently your active task graph), should the comm wallet's lock script migrate to ML-DSA? Yes, but only after at least one production season on secp256k1 to limit moving pieces. Track as separate Phase 2.8 item.
5. **Pairing transport when both peers are remote.** QR works for in-person pairing. For remote, the same QR payload could be exchanged via Signal/Matrix/Keybase — out-of-band trust still required, but well-understood by users who do PGP.

## What we are explicitly not building in v1

- Forward secrecy / double ratchet
- PQC encryption (Kyber/ML-KEM)
- PQC comm-wallet lock script (stays secp256k1 in v1)
- Cell-level type-script validator
- Anonymity against network-level observer (no Tor/i2p integration)
- Multi-device sync for a single user's comm key
- Group messaging beyond pairwise

## References

- CKB cell-data semantics: kb/01-cell-model.md (`### data`)
- ChainPay light-client API: `apps/desktop/src/lib/light-client/host.ts:128-172` (`watchLockScript` + `listCellsForLock` + `broadcastTransaction`)
- Spore data-cell layouts as molecule precedent: `raw/spore-contract/lib/types/src/generated/spore_v1.rs:700`
- ML-DSA lock for v2 PQC migration: `~/ckb-mldsa-lock/crates/sdk-rust/src/lib.rs:83` (`MlDsaKeyPair::lock_args`)

## Addendum 2026-05-21 — CEMP-PQ integration shape

`~/ecms/cemp-pq/` ships the actual encrypted-relay protocol. ChainPay's Phase 2.7 work reduces to integration, not design.

### What CEMP-PQ provides

- **ML-DSA-65 (Dilithium) identity** via `ckb-mldsa-lock`. Each ChainPay install holds an ML-DSA keypair as its comm wallet. Lock code hash on testnet: `0x8984f4230ded4ac1f5efee2b67fef45fcda08bd6344c133a2f378e2f469d310d`. PQC-grade from day one — no Phase 2.8 migration.
- **ML-KEM-768 (Kyber) hybrid encryption** for payloads. Sender encapsulates a fresh symmetric key under the recipient's ML-KEM public key; the recipient decapsulates with their secret. No PSK ceremony.
- **Profile Cell discovery**: each user publishes one Profile Cell (`schemas/cemp-pq.mol Profile { ml_dsa_public_key, ml_kem_public_key, metadata }`) at their lock. Anyone can fetch it via `CEMPTransactionBuilder.fetchRecipientProfile()`. This is the address book — trust root is on chain.
- **Two-cell send pattern**: Message Cell (sender-owned, ciphertext) + Notification Cell (recipient-owned, MessagePointer to the Message). Recipient inbox = tiny pointer cells, not the full ciphertext stream.

### ChainPay integration scope (Phase 2.7 revised)

1. **First-run setup**: on Electron install, generate an ML-DSA-65 keypair, write to localStorage (same persist pattern as treasury/clipboard stores). Prompt user to fund the derived `ckb-mldsa-lock` address with ~50 CKB.
2. **Profile publication**: one-time tx that creates the Profile Cell containing the install's ML-DSA + ML-KEM public keys + a metadata blob (display name, allowed packet kinds). Reuses `CEMPTransactionBuilder.buildCreateProfileTx`.
3. **Peer/address book UI**: editable list of `{ nickname, ckbAddress, lastProfileCheckedAt }`. Resolve to ML-KEM pubkey on-demand via CEMP-PQ's profile discovery; cache the result.
4. **Send signature/packet**: wrap the existing TransferPacket / signature blob → `CEMPTransactionBuilder.buildSendMessageTx(signer, recipientLock, encodedPayload)`. Broadcast through the same `LightClientHost.broadcastTransaction` path that landed Phase 2 (full-node RPC override at `.134:8114`).
5. **Receive**: `LightClientHost.watchLockScript(ownLock)` (already shipped) sees Notification Cells; follow `MessagePointer.tx_hash:index` to retrieve the Message Cell, decrypt with the install's ML-KEM secret, hand the decoded payload to whichever ChainPay panel it belongs to (SignPanel for incoming packets, PayPanel for incoming signatures).
6. **Refusal invariant** (preserved from original design): the ML-DSA comm-wallet pubkey hash must never equal any multisig signer's blake160. Enforce in `addPeer()` and in the install-time keypair generation.

### Witness sizing

ML-DSA-65 signatures are ~3300 bytes, dramatically larger than secp256k1's 65 bytes. `CEMPTransactionBuilder` reserves 5300 bytes for the full WitnessArgs. When `buildPaymentSkeleton` style fee estimation gets ported into the comm-channel send path, the witness pre-pad must be 5300, not the 194 bytes the secp256k1 multisig uses.

### What's still TBD upstream in CEMP-PQ

- Profile Cell type script is a placeholder (`CEMP_PQ_PROFILE_CODE_HASH = 0x00…01`). Discovery currently falls back to a data-length heuristic (`cell.outputData.length > 3000`).
- `Receipt` table exists in the schema but isn't issued by `buildSendMessageTx` yet — confirms of delivery would close that loop.
- Address rotation (HKDF chain per session) hasn't been integrated. Could land as an envelope-level concern without changing CEMP-PQ's core.

### What this means for sequencing

Phase 2.5 (payroll batch) still ships first — unchanged. Phase 2.7's body of work compresses from "build encrypted relay + PSK ceremony + AES envelope + PQC migration plan" down to "integrate CEMP-PQ; build the ChainPay-side UI surfaces and lifecycle hooks". Estimate: a week of focused work once Phase 2.5 lands and CEMP-PQ's profile-cell type-script is finalised.
