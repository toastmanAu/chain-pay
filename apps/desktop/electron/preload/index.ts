import { contextBridge, ipcRenderer } from "electron";
import type { PairedDevice } from "../main/pair-store";
import {
  KEYVAULT_CHANNELS,
  type SignTxRequest,
} from "../../../../packages/shared/src/keyvault-ipc";
import {
  BITCOIN_CHANNELS,
  type BitcoinChain,
  type BitcoinProviderStatus,
  type BitcoinScanRequest,
  type BitcoinScanResponse,
  type BitcoinTransactionStatusRequest,
  type BitcoinTransactionStatusResponse,
} from "../../../../packages/shared/src";

const platformApi = {
  platform: process.platform,
  versions: process.versions,
};

contextBridge.exposeInMainWorld("platform", platformApi);

export type PlatformApi = typeof platformApi;

const chainpayApi = {
  commIdentity: {
    exists: (): Promise<boolean> => ipcRenderer.invoke("commIdentity:exists"),
    publicInfo: (): Promise<{
      mlDsaPub: string;
      mlKemPub: string;
      address: string;
      addresses: { testnet: string; mainnet: string | null };
      publishedOn: ("testnet" | "mainnet")[];
      addrHash: string;
      createdAt: number;
    } | null> => ipcRenderer.invoke("commIdentity:publicInfo"),
    generate: (): Promise<{
      mlDsaPub: string;
      mlKemPub: string;
      address: string;
      addrHash: string;
      createdAt: number;
    }> => ipcRenderer.invoke("commIdentity:generate"),
    delete: (): Promise<void> => ipcRenderer.invoke("commIdentity:delete"),
  },
  commTransport: {
    publishProfile: (
      metadata: { displayName?: string } | undefined,
    ): Promise<{ txHash: string; txBytes: string }> =>
      ipcRenderer.invoke("commTransport:publishProfile", metadata ?? {}),
    sendMessage: (
      recipientAddress: string,
      envelopeBytesHex: string,
    ): Promise<{ txHash: string; txBytes: string }> =>
      ipcRenderer.invoke(
        "commTransport:sendMessage",
        recipientAddress,
        envelopeBytesHex,
      ),
    decryptIncoming: (messageOutPoint: {
      txHash: string;
      index: number;
    }): Promise<string> =>
      ipcRenderer.invoke("commTransport:decryptIncoming", messageOutPoint),
    resolveProfile: (address: string): Promise<{
      address: string;
      mlDsaPubKey: string;
      mlKemPubKey: string;
      metadata: string;
    }> => ipcRenderer.invoke("commTransport:resolveProfile", address),
  },
  network: {
    get: (): Promise<"testnet" | "mainnet"> =>
      ipcRenderer.invoke("network:get"),
    set: (network: "testnet" | "mainnet"): Promise<void> =>
      ipcRenderer.invoke("network:set", network),
  },
  lcStorage: {
    clear: (): Promise<void> => ipcRenderer.invoke("lcStorage:clear"),
  },
  app: {
    quit: (): Promise<void> => ipcRenderer.invoke("app:quit"),
  },
  invoiceFiles: {
    store: (bytes: Uint8Array, sha256: string): Promise<string> =>
      ipcRenderer.invoke("invoice-files:store", bytes, sha256),
    read: (uri: string): Promise<Uint8Array> =>
      ipcRenderer.invoke("invoice-files:read", uri),
    delete: (uri: string): Promise<void> =>
      ipcRenderer.invoke("invoice-files:delete", uri),
  },
  pair: {
    list: (): Promise<PairedDevice[]> => ipcRenderer.invoke("pair:list"),
    revoke: (tokenId: string): Promise<void> =>
      ipcRenderer.invoke("pair:revoke", tokenId),
    issue: (deviceLabel: string): Promise<{ token: string; tokenId: string }> =>
      ipcRenderer.invoke("pair:issue", deviceLabel),
    setCommPubkey: (tokenId: string, commPubkey: string): Promise<void> =>
      ipcRenderer.invoke("pair:setCommPubkey", tokenId, commPubkey),
    info: (): Promise<{ certFingerprint: string; port: number } | null> =>
      ipcRenderer.invoke("pair:info"),
    rotateCert: (): Promise<
      | { ok: true; fingerprint: string; port: number }
      | { ok: false; reason: string }
    > => ipcRenderer.invoke("pair:rotateCert"),
    onInvoiceReceived: (cb: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, p: unknown): void => cb(p);
      ipcRenderer.on("mobile-invoice:received", listener);
      return () => {
        ipcRenderer.removeListener("mobile-invoice:received", listener);
      };
    },
  },
  accounting: {
    postJournal: (
      record: unknown,
    ): Promise<{
      jeName: string;
      idempotent: boolean;
      recordName: string;
      recordIdempotent: boolean;
    }> => ipcRenderer.invoke("accounting:postJournal", record),
    exportCompliance: (
      filters: {
        fromDate?: string;
        toDate?: string;
        chain?: "ckb:mainnet" | "ckb:testnet" | "evm:11155111";
      },
      format: "csv" | "pdf",
    ): Promise<{
      canceled: boolean;
      filePath?: string;
      rowCount?: number;
      sha256?: string;
    }> => ipcRenderer.invoke("accounting:exportCompliance", filters, format),
  },
  bitcoin: {
    status: (chain: BitcoinChain): Promise<BitcoinProviderStatus> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.status, chain),
    scan: (request: BitcoinScanRequest): Promise<BitcoinScanResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.scan, request),
    transactionStatus: (
      request: BitcoinTransactionStatusRequest,
    ): Promise<BitcoinTransactionStatusResponse> =>
      ipcRenderer.invoke(BITCOIN_CHANNELS.transactionStatus, request),
  },
  keyvault: {
    /** Check whether a keyvault blob exists on disk. */
    status: (): Promise<{ exists: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.status),
    /** Generate a new BIP39 mnemonic, encrypt it, and persist it. */
    create: (
      password: string,
    ): Promise<{ id: string; lockArgs: string; mnemonic: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.create, { password }),
    /** Import an existing BIP39 mnemonic phrase into a new keyvault. */
    import: (
      mnemonic: string,
      password: string,
    ): Promise<{ id: string; lockArgs: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.import, { mnemonic, password }),
    /** Decrypt the keyvault and return derived lock-args without signing. */
    unlockDerive: (
      keyvaultId: string,
      password: string,
      derivationIndex: number,
    ): Promise<{ lockArgs: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.unlockDerive, {
        keyvaultId,
        password,
        derivationIndex,
      }),
    /** Sign a CKB tx inside main (anti-blind-sign enforced; digest recomputed in main). */
    signTx: (req: SignTxRequest): Promise<{ signedTx: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.signTx, req),
    /** Export the mnemonic phrase (shown once; caller must zeroize). */
    export: (
      keyvaultId: string,
      password: string,
    ): Promise<{ mnemonic: string }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.export, { keyvaultId, password }),
    /** Re-encrypt the keyvault blob under a new password. */
    changePassword: (
      keyvaultId: string,
      oldPassword: string,
      newPassword: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.changePassword, {
        keyvaultId,
        oldPassword,
        newPassword,
      }),
    /** Permanently delete the keyvault blob from disk. */
    delete: (keyvaultId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(KEYVAULT_CHANNELS.delete, { keyvaultId }),
  },
};

contextBridge.exposeInMainWorld("chainpay", chainpayApi);

export type ChainpayApi = typeof chainpayApi;
