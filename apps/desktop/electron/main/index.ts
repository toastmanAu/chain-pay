import { app, BrowserWindow, session, shell } from "electron";
import { join } from "node:path";

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
