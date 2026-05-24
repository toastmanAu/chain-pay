import { Address, ClientPublicTestnet } from "@ckb-ccc/core";

/**
 * Derive the 20-byte refusal-invariant hash for a peer's comm-channel address.
 *
 * The cemp-pq lock embeds the canonical "comm identity hash" as the first
 * 20 bytes of the lock script's args. This is the same value the main process
 * computes during identity generation (see deriveIdentityLock in
 * comm-transport-service.ts). We surface it here so the renderer's AddPeerForm
 * can supply candidateHash to peer-book.addPeer without an extra IPC round-trip.
 *
 * Uses a no-network ClientPublicTestnet parser — address parsing for the
 * mldsa-lock prefix is purely deterministic.
 */
export async function peerHashFromAddress(address: string): Promise<Uint8Array> {
  const parser = new ClientPublicTestnet();
  const lock = (await Address.fromString(address, parser)).script;
  const argsHex = lock.args.startsWith("0x") ? lock.args.slice(2) : lock.args;
  if (argsHex.length < 40) {
    throw new Error(
      `address lock args too short for comm hash: got ${argsHex.length / 2} bytes, need ≥20`,
    );
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(argsHex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
