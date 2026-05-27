import { contextBridge, ipcRenderer } from "electron";

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
  invoiceFiles: {
    store: (bytes: Uint8Array, sha256: string): Promise<string> =>
      ipcRenderer.invoke("invoice-files:store", bytes, sha256),
    read: (uri: string): Promise<Uint8Array> =>
      ipcRenderer.invoke("invoice-files:read", uri),
    delete: (uri: string): Promise<void> =>
      ipcRenderer.invoke("invoice-files:delete", uri),
  },
};

contextBridge.exposeInMainWorld("chainpay", chainpayApi);

export type ChainpayApi = typeof chainpayApi;
