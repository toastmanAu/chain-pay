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
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: resolve(__dirname, "index.html") },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
    plugins: [react(), tailwindcss()],
    server: { port: 5173 },
  },
});
