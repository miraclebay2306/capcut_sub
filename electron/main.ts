import { app, BrowserWindow, ipcMain, dialog, safeStorage } from "electron";
import * as path from "path";
import * as fs from "fs";
import { runPipeline } from "../src/core/pipeline";
import { PipelineConfig, PipelineProgress } from "../src/core/types";

let mainWindow: BrowserWindow | null = null;

// Encrypted API key is stored here (OS-level encryption via Electron's
// safeStorage — DPAPI on Windows). This replaces the spec's original
// "localStorage" idea, which is not a secure place to keep a secret on disk.
const keyStorePath = () => path.join(app.getPath("userData"), "api.key");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#14151A",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(
    path.join(__dirname, "..", "..", "renderer", "index.html"),
  );
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// IPC: directory picker
// ---------------------------------------------------------------------------
ipcMain.handle("select-project-directory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "ເລືອກໂຟນເດີໂຄງການ CapCut",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---------------------------------------------------------------------------
// IPC: secure API key storage ("Remember Key" toggle)
// ---------------------------------------------------------------------------
ipcMain.handle("save-api-key", async (_e, apiKey: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("ລະບົບຈັດເກັ່ງຂໍ້ມູນປອດໄພຂອງ OS ບໍ່ພົບໃນເຄື່ອງນີ້.");
  }
  const encrypted = safeStorage.encryptString(apiKey);
  fs.writeFileSync(keyStorePath(), encrypted);
  return true;
});

ipcMain.handle("load-api-key", async () => {
  try {
    if (!fs.existsSync(keyStorePath())) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = fs.readFileSync(keyStorePath());
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
});

ipcMain.handle("clear-api-key", async () => {
  if (fs.existsSync(keyStorePath())) fs.unlinkSync(keyStorePath());
  return true;
});

// ---------------------------------------------------------------------------
// IPC: run the full pipeline, streaming progress back to the renderer
// ---------------------------------------------------------------------------
ipcMain.handle("run-pipeline", async (event, config: PipelineConfig) => {
  const sender = event.sender;
  const onProgress = (p: PipelineProgress) => {
    sender.send("pipeline-progress", p);
  };
  return runPipeline(config, onProgress);
});
