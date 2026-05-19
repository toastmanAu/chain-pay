import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { LightClientHost } from "./light-client-host";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
const lightClient = new LightClientHost();

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

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("ckb:start", (_, network: "mainnet" | "testnet") => lightClient.start(network));
  ipcMain.handle("ckb:stop", () => lightClient.stop());
  ipcMain.handle("ckb:status", () => lightClient.status());
  ipcMain.handle("ckb:tip-header", () => lightClient.tipHeader());
  ipcMain.handle("ckb:get-cells-capacity", (_, searchKey) => lightClient.getCellsCapacity(searchKey));
  ipcMain.handle("ckb:get-transactions", (_, searchKey, order, limit, cursor) =>
    lightClient.getTransactions(searchKey, order, limit, cursor),
  );

  lightClient.on("sync-progress", (progress) => {
    mainWindow?.webContents.send("ckb:sync-progress", progress);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", async () => {
  await lightClient.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await lightClient.stop();
});
