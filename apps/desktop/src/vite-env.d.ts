/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAPPE_BASE_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_CKB_NETWORK?: "mainnet" | "testnet";
  readonly VITE_EVM_SEPOLIA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

import type { ChainpayApi, PlatformApi } from "../electron/preload/index";

declare global {
  interface Window {
    platform: PlatformApi;
    chainpay: ChainpayApi;
    ethereum?: import("./lib/chains/evm/injected-owner-signer").Eip1193Provider;
  }
}

export {};
