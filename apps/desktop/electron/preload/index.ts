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
};

contextBridge.exposeInMainWorld("chainpay", chainpayApi);

export type ChainpayApi = typeof chainpayApi;
