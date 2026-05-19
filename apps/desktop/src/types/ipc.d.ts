import type { CkbApi } from "../../electron/preload/index";

declare global {
  interface Window {
    ckb: CkbApi;
  }
}

export {};
