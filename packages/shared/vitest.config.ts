import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@chain-pay/shared": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
