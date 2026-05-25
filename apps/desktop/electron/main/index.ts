import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import {
  exists as commExists,
  publicInfo as commPublicInfo,
  generateIdentity,
  deleteIdentity,
  publishProfile,
  sendMessage,
  decryptIncoming,
  resolveProfile,
} from "./comm-transport-service";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// 'wasm-unsafe-eval' is needed for WebAssembly.instantiate.
// blob: for the ckb-light-client-js workers, which esbuild inlines and spawns via blob URLs.
// In dev, 'unsafe-inline' is needed for Vite's HMR preamble script. Stripped in prod.
const scriptSrc = isDev
  ? "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' blob:"
  : "script-src 'self' 'wasm-unsafe-eval' blob:";

// connect-src needs `http:` because ChainPay points at user-configured local /
// LAN CKB nodes (e.g. http://192.168.68.134:8114 in dev, or a self-hosted
// full-node on the same machine). A desktop wallet's threat model differs
// from a browser-served page — there's no XSS surface that could exfil to an
// attacker-controlled HTTP endpoint. `https:` / `wss:` / `ws:` stay allowed
// for public testnet/mainnet RPCs.
const CSP = [
  "default-src 'self'",
  scriptSrc,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' http: https: wss: ws: blob:",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
].join("; ");

function applyResponseHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Cross-Origin-Embedder-Policy": ["require-corp"],
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDev) {
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const tag = ["LOG", "WARN", "ERROR", "DBG"][level] ?? "LOG";
      process.stdout.write(`[renderer ${tag}] ${message} (${sourceId}:${line})\n`);
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  applyResponseHeaders();
  await createWindow();

  // comm-identity handlers
  ipcMain.handle("commIdentity:exists", () => commExists());
  ipcMain.handle("commIdentity:publicInfo", () => commPublicInfo());
  ipcMain.handle("commIdentity:generate", () => generateIdentity());
  ipcMain.handle("commIdentity:delete", () => deleteIdentity());

  // comm-transport handlers
  // Renderer currently sends the bare metadata object (legacy shape from Phase 2.7a/b).
  // Wrap into {metadata} so publishProfile receives the correct args shape.
  // Task 5/6 will later update the renderer to pass {metadata, network} explicitly.
  ipcMain.handle("commTransport:publishProfile", (_e, metadata) => publishProfile({ metadata }));
  ipcMain.handle(
    "commTransport:sendMessage",
    (_e, recipientAddress: string, envelopeBytesHex: string) => {
      const envelopeBytes = Uint8Array.from(Buffer.from(envelopeBytesHex.slice(2), "hex"));
      return sendMessage(recipientAddress, envelopeBytes);
    },
  );
  ipcMain.handle(
    "commTransport:decryptIncoming",
    (_e, messageOutPoint: { txHash: string; index: number }) => decryptIncoming(messageOutPoint),
  );
  ipcMain.handle("commTransport:resolveProfile", (_e, address: string) =>
    resolveProfile(address),
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
