import { Address, ClientPublicTestnet, ClientPublicMainnet, Transaction } from "@ckb-ccc/core";
import type { Client } from "@ckb-ccc/core";
import { lightClient } from "../light-client/client";
import { useCommIdentityStore } from "../../stores/comm-identity";
import { useSyncStore } from "../../stores/sync";
import { CempPqCommTransport } from "./cemp-pq/transport";
import type { CommTransport, PeerProfile, OutgoingPacket, OutgoingSignature } from "./types";

export type { CommTransport, PeerProfile, OutgoingPacket, OutgoingSignature };

let cached: { transport: CempPqCommTransport; identityAddress: string } | null = null;

function getCccClient(): Client {
  const network = useSyncStore.getState().ckb.network;
  if (network === "mainnet") return new ClientPublicMainnet();
  // Default to testnet for Phase 2.7a smoke; mainnet gated behind explicit LC start.
  return new ClientPublicTestnet();
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * MessagePointer molecule layout produced by cemp-pq serializeMessagePointer:
 *   full_size(u32LE 4B)
 *   off_tx(u32LE 4B)      — offset to tx field (= HDR = 12)
 *   off_idx(u32LE 4B)     — offset to index field (= HDR + tx_ser.length)
 *   tx_ser = len(u32LE 4B) + tx_bytes(32B)
 *   index(u32LE 4B)
 *
 * Total: 4+4+4 + (4+32) + 4 = 52 bytes
 */
function parseMessagePointer(outputDataHex: string): { txHash: string; index: number } {
  const bytes = hexToBytes(outputDataHex);
  const view = new DataView(bytes.buffer, bytes.byteOffset);

  // HDR = 4 (full_size) + 2*4 (off_tx, off_idx) = 12
  const HDR = 12;
  // tx_ser = 4-byte length prefix + 32-byte hash; read offset from the offsets table
  const offTx = view.getUint32(4, true);
  const offIdx = view.getUint32(8, true);

  // tx bytes start 4 bytes after offTx (skip the length prefix)
  const txStart = offTx + 4;
  const txEnd = txStart + 32;
  const txHashBytes = bytes.slice(txStart, txEnd);
  const txHash =
    "0x" +
    Array.from(txHashBytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const index = view.getUint32(offIdx, true);

  return { txHash, index };
}

export function createCommTransport(): CommTransport | null {
  const identity = useCommIdentityStore.getState().identity;
  if (!identity) {
    if (cached) {
      void cached.transport.stop();
      cached = null;
    }
    return null;
  }
  if (cached && cached.identityAddress === identity.address) {
    return cached.transport;
  }
  if (cached) void cached.transport.stop();

  const transport = new CempPqCommTransport({
    getOwnLock: async () => {
      const client = getCccClient();
      const addr = await Address.fromString(identity.address, client);
      return {
        codeHash: addr.script.codeHash,
        hashType: addr.script.hashType,
        args: addr.script.args,
      };
    },

    getOwnAddrHash: async () => {
      const client = getCccClient();
      const addr = await Address.fromString(identity.address, client);
      // The envelope's senderAddrHash is the first 20 bytes of the lock args (blake160).
      const argsHex = addr.script.args.startsWith("0x")
        ? addr.script.args.slice(2)
        : addr.script.args;
      const out = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        out[i] = parseInt(argsHex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    },

    getProfilePublishBlock: async () => {
      const current = useCommIdentityStore.getState().identity;
      if (!current?.profileTxHash) return null;
      try {
        const client = getCccClient();
        const resp = await client.getTransaction(current.profileTxHash);
        if (!resp?.blockNumber) return null;
        return BigInt(resp.blockNumber);
      } catch {
        return null;
      }
    },

    ipc: {
      publishProfile: (metadata) =>
        window.chainpay.commTransport.publishProfile(metadata),
      sendMessage: (recipientAddress, envelopeBytesHex) =>
        window.chainpay.commTransport.sendMessage(recipientAddress, envelopeBytesHex),
      decryptIncoming: (outPoint) =>
        window.chainpay.commTransport.decryptIncoming(outPoint),
      resolveProfile: (address) =>
        window.chainpay.commTransport.resolveProfile(address),
    },

    broadcastTransaction: async (txBytesHex) => {
      const txBytes = hexToBytes(txBytesHex);
      const tx = Transaction.fromBytes(txBytes);
      const hash = await lightClient().broadcastTransaction(tx);
      return String(hash);
    },

    watchLockScript: async (script, fromBlock) => {
      await lightClient().watchLockScript(
        {
          codeHash: script.codeHash,
          hashType: script.hashType,
          args: script.args,
        },
        fromBlock,
      );
    },

    listCellsForLock: async (script) => {
      const cells = await lightClient().listCellsForLock({
        codeHash: script.codeHash,
        hashType: script.hashType,
        args: script.args,
      });
      return cells.map((c) => ({
        outPoint: {
          txHash: String(c.outPoint.txHash),
          index: Number(c.outPoint.index),
        },
        outputData: String(c.outputData),
      }));
    },

    parseMessagePointer,
  });

  cached = { transport, identityAddress: identity.address };
  return transport;
}

/**
 * Stop and clear the cached singleton. Called by the comm-identity store's
 * actions (or App.tsx boot) when the identity changes. Safe to call at any time.
 */
export function resetCommTransport(): void {
  if (cached) {
    void cached.transport.stop();
    cached = null;
  }
}
