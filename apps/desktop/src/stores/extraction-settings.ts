import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type ExtractionBackend = "tesseract" | "surya-remote";
export type SuryaTestResult = "ok" | "unreachable" | "bad-response";

interface ExtractionSettingsStore {
  extractionBackend: ExtractionBackend;
  suryaEndpointUrl: string;
  suryaLastTestedAt: string | undefined;
  suryaLastTestResult: SuryaTestResult | undefined;
  setExtractionBackend: (b: ExtractionBackend) => void;
  setSuryaEndpointUrl: (url: string) => void;
  recordSuryaTest: (result: SuryaTestResult) => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useExtractionSettingsStore = create<ExtractionSettingsStore>()(
  persist(
    (set) => ({
      extractionBackend: "tesseract",
      suryaEndpointUrl: "http://localhost:9991/v1",
      suryaLastTestedAt: undefined,
      suryaLastTestResult: undefined,
      setExtractionBackend: (b) => set({ extractionBackend: b }),
      setSuryaEndpointUrl: (url) =>
        set({ suryaEndpointUrl: url, suryaLastTestedAt: undefined, suryaLastTestResult: undefined }),
      recordSuryaTest: (result) =>
        set({ suryaLastTestResult: result, suryaLastTestedAt: new Date().toISOString() }),
    }),
    {
      name: "chain-pay:extraction-settings",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({
        extractionBackend: state.extractionBackend,
        suryaEndpointUrl: state.suryaEndpointUrl,
        suryaLastTestedAt: state.suryaLastTestedAt,
        suryaLastTestResult: state.suryaLastTestResult,
      }),
    },
  ),
);
