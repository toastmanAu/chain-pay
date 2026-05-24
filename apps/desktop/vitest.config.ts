import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../../packages/shared/src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    environment: "node",
    // React component tests opt into jsdom via `// @vitest-environment jsdom`
    // at the top of the test file. Node default keeps non-DOM tests fast.
  },
});
