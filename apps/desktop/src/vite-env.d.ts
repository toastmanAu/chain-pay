/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAPPE_BASE_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_CKB_NETWORK?: "mainnet" | "testnet";
  readonly VITE_EVM_SEPOLIA_RPC_URL?: string;
}

// Ambient declaration merging with vite/client's `ImportMeta` — augments `import.meta.env`
// project-wide via TypeScript's global interface merging, not a local code reference, so
// eslint's usage analysis can't see the effect. Renaming would break the merge.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
