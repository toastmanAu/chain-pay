import { vi } from "vitest";

vi.mock("react-native-mmkv", () => {
  const store = new Map<string, string>();
  const instance = {
    set(k: string, v: string) {
      store.set(k, v);
    },
    getString(k: string) {
      return store.get(k);
    },
    remove(k: string) {
      store.delete(k);
    },
    contains(k: string) {
      return store.has(k);
    },
    clearAll() {
      store.clear();
    },
  };
  return {
    createMMKV: () => instance,
  };
});

vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  cacheDirectory: "/tmp/test-cache/",
  writeAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
}));
