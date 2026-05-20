import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "../../packages/shared/src") },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      // sandbox: true (in electron/main/index.ts) requires CJS preload — ESM is not supported.
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        onwarn(warning, defaultHandler) {
          if (warning.code === "SOURCEMAP_ERROR") return;
          defaultHandler(warning);
        },
      },
      target: "esnext",
      sourcemap: false,
    },
    optimizeDeps: {
      exclude: ["@nervosnetwork/ckb-light-client-js"],
    },
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
    },
  },
});
