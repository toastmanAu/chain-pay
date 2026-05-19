/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAPPE_BASE_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_CKB_NETWORK?: "mainnet" | "testnet";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

import type { PlatformApi } from "../electron/preload/index";

declare global {
  interface Window {
    platform: PlatformApi;
  }
}

export {};
