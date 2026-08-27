import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CaptureBroker,
  type CaptureRecord,
  type CaptureResponse
} from "./main/capture-broker";
import { createCredentialProtection } from "./main/credential-protection";
import { DownloadManager, type DownloadRecord } from "./main/download-manager";
import { IntegrationServer, type ExtensionDownloadRequest } from "./main/integration-server";
import { SettingsStore, type AppSettings, type SettingsPatch } from "./main/settings";

const APP_PROTOCOL = "bunni";
const DEFAULT_PORT = 17_865;

let mainWindow: BrowserWindow | undefined;
let downloadManager: DownloadManager;
let settingsStore: SettingsStore;
let integrationServer: IntegrationServer;
let captureBroker: CaptureBroker<ExtensionDownloadRequest, DownloadRecord>;
let updateTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let initialized = false;
let focusWhenReady = false;
let rendererReady = false;
const pendingProtocolUrls: string[] = [];
const pendingCaptureEvents = new Map<string, CaptureRecord<DownloadRecord>>();
const deliveredCaptureEvents = new Set<string>();
const previousStatuses = new Map<string, string>();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function rendererFile(): string {
  return path.join(app.getAppPath(), "src", "renderer", "index.html");
}

function extensionDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "extension")
    : path.join(app.getAppPath(), "extension");
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    throw new Error("Invalid download identifier.");
  }
  return id;
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !senderFrame
    || senderFrame.processId !== mainFrame.processId
    || senderFrame.routingId !== mainFrame.routingId
  ) {
    throw new Error("This request did not come from the Bunni application window.");
  }
}

function validateSettingsPatch(input: unknown): SettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Settings update is required.");
  }

  const candidate = input as Record<string, unknown>;
  const allowedKeys = new Set<keyof AppSettings>([
    "downloadDirectory",
    "defaultSegments",
    "maxConcurrent",
    "serverPort",
    "notifyOnComplete"
  ]);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key as keyof AppSettings)) throw new Error(`Unknown setting: ${key}`);
  }

  const patch: SettingsPatch = {};
  if (Object.hasOwn(candidate, "downloadDirectory")) {
    if (typeof candidate.downloadDirectory !== "string") throw new Error("Download directory must be a path.");
    const directory = candidate.downloadDirectory.trim();
    if (!directory || !path.isAbsolute(directory)) throw new Error("Choose an absolute download directory.");
    patch.downloadDirectory = path.normalize(directory);
  }

  const integerSetting = (
    key: "defaultSegments" | "maxConcurrent" | "serverPort",
    minimum: number,
    maximum: number
  ): void => {
    if (!Object.hasOwn(candidate, key)) return;
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
    }
    patch[key] = value;
  };
  integerSetting("defaultSegments", 1, 32);
  integerSetting("maxConcurrent", 1, 10);
  integerSetting("serverPort", 1024, 65_535);

  if (Object.hasOwn(candidate, "notifyOnComplete")) {
    if (typeof candidate.notifyOnComplete !== "boolean") throw new Error("Notification preference must be true or false.");
    patch.notifyOnComplete = candidate.notifyOnComplete;
  }
  return patch;
}

function validateAddInput(input: unknown): ExtensionDownloadRequest & { directory?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Download details are required.");
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.url !== "string") throw new Error("Enter a download URL.");
  const rawUrl = candidate.url.trim();
  if (!rawUrl || rawUrl.length > 16_384) throw new Error("Enter a valid download URL.");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid download URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS downloads are supported.");
  }

  const result: ExtensionDownloadRequest & { directory?: string } = { url: url.toString() };
  if (Object.hasOwn(candidate, "fileName")) {
    if (typeof candidate.fileName !== "string" || candidate.fileName.length > 1_024) throw new Error("File name is invalid.");
    if (candidate.fileName.trim()) result.fileName = candidate.fileName.trim();
  }
  if (Object.hasOwn(candidate, "directory")) {
    if (typeof candidate.directory !== "string" || !path.isAbsolute(candidate.directory)) {
      throw new Error("Download directory must be an absolute path.");
    }
    result.directory = path.normalize(candidate.directory);
  }
  if (candidate.segments !== undefined) {
    if (typeof candidate.segments !== "number" || !Number.isInteger(candidate.segments) || candidate.segments < 1 || candidate.segments > 32) {
      throw new Error("Segment count must be an integer between 1 and 32.");
    }
    result.segments = candidate.segments;
  }
  if (Object.hasOwn(candidate, "headers")) {
    if (!candidate.headers || typeof candidate.headers !== "object" || Array.isArray(candidate.headers)) {
      throw new Error("Download headers must be a key-value object.");
    }
    const entries = Object.entries(candidate.headers as Record<string, unknown>);
    if (entries.length > 100) throw new Error("Too many download headers were provided.");
    const headers: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (typeof value !== "string" || key.length > 256 || value.length > 8_192 || /[\r\n]/.test(`${key}${value}`)) {
        throw new Error("Download headers are invalid.");
      }
      headers[key] = value;
    }
    result.headers = headers;
  }
  return result;
}

function validateCaptureResponse(input: unknown): CaptureResponse {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A capture response is required.");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = new Set(["id", "action", "fileName", "directory"]);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown capture response field: ${key}`);
  }

  const id = validateId(candidate.id);
  if (candidate.action !== "start" && candidate.action !== "later" && candidate.action !== "cancel") {
    throw new Error("Capture action must be start, later, or cancel.");
  }
  const response: CaptureResponse = { id, action: candidate.action };
  if (Object.hasOwn(candidate, "fileName")) {
    if (
      typeof candidate.fileName !== "string"
      || !candidate.fileName.trim()
      || candidate.fileName.length > 1_024
      || candidate.fileName.includes("\0")
    ) {
      throw new Error("File name is invalid.");
    }
    response.fileName = candidate.fileName.trim();
  }
  if (Object.hasOwn(candidate, "directory")) {
    if (
      typeof candidate.directory !== "string"
      || candidate.directory.length > 32_767
      || candidate.directory.includes("\0")
      || !path.isAbsolute(candidate.directory)
    ) {
      throw new Error("Download directory must be an absolute path.");
    }
    response.directory = path.normalize(candidate.directory);
  }
  if (response.action === "cancel" && (response.fileName !== undefined || response.directory !== undefined)) {
    throw new Error("A cancelled capture cannot change its destination.");
  }
  return response;
}

async function addDownload(
  rawInput: unknown,
  behavior: { startPaused?: boolean } = {}
): Promise<DownloadRecord> {
  const input = validateAddInput(rawInput);
  const settings = settingsStore.get();
  const directory = input.directory ?? settings.downloadDirectory;
  await mkdir(directory, { recursive: true });
  return downloadManager.add({
    ...input,
    directory,
    segments: input.segments ?? settings.defaultSegments,
    startPaused: behavior.startPaused
  });
}

function integrationOptions(port = settingsStore.get().serverPort) {
  return {
    port,
    addDownload,
    listDownloads: () => downloadManager.list(),
    createCapture: (input: ExtensionDownloadRequest) => captureBroker.create(input),
    getCapture: (id: string) => captureBroker.get(id),
    rejectCapture: (id: string) => captureBroker.reject(id)
  };
}

function aggregateStats(records: DownloadRecord[]) {
  const active = records.filter((record) => record.status === "downloading");
  return {
    active: active.length,
    queued: records.filter((record) => record.status === "queued").length,
    completed: records.filter((record) => record.status === "completed").length,
    speed: active.reduce((sum, record) => sum + (Number(record.speed) || 0), 0)
  };
}

function notifyForTransitions(records: DownloadRecord[]): void {
  const notificationsEnabled = settingsStore.get().notifyOnComplete;
  const currentIds = new Set(records.map((record) => record.id));
  for (const id of previousStatuses.keys()) {
    if (!currentIds.has(id)) previousStatuses.delete(id);
  }
  for (const record of records) {
    const previous = previousStatuses.get(record.id);
    previousStatuses.set(record.id, record.status);
    if (!previous || previous === record.status) continue;
    if (notificationsEnabled && record.status === "completed" && Notification.isSupported()) {
      new Notification({
        title: "Download complete",
        body: record.fileName,
        silent: false
      }).show();
    }
    if (record.status === "error" && Notification.isSupported()) {
      new Notification({ title: "Download needs attention", body: record.error || record.fileName }).show();
    }
  }
}

function broadcastDownloads(): void {
  if (shuttingDown || updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    if (shuttingDown) return;
    const records = downloadManager.list();
    notifyForTransitions(records);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("downloads:changed", records);
    mainWindow.webContents.send("downloads:stats", aggregateStats(records));
  }, 150);
}

function flushCaptureRequests(): void {
  const window = mainWindow;
  if (!rendererReady || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  for (const [id, capture] of pendingCaptureEvents) {
    if (captureBroker.get(id)?.state !== "pending") {
      pendingCaptureEvents.delete(id);
      deliveredCaptureEvents.delete(id);
      continue;
    }
    if (deliveredCaptureEvents.has(id)) continue;
    try {
      window.webContents.send("capture:requested", capture);
      deliveredCaptureEvents.add(id);
    } catch (error) {
      console.error("Could not deliver a browser capture to the Bunni window:", error);
      return;
    }
  }
}

function requestCapture(capture: CaptureRecord<DownloadRecord>): void {
  pendingCaptureEvents.set(capture.id, capture);
  focusWindow();
  flushCaptureRequests();
}

function findRecord(id: string): DownloadRecord {
  const record = downloadManager.list().find((entry) => entry.id === id);
  if (!record) throw new Error("Download not found.");
  return record;
}

async function openUrlInChrome(url: URL): Promise<void> {
  if (process.platform === "win32") {
    const chromeCandidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of chromeCandidates) {
      try {
        await access(candidate, fsConstants.X_OK);
        const child = spawn(candidate, [url.toString()], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: false
        });
        child.unref();
        return;
      } catch {
        // Try the next standard Chrome installation location.
      }
    }
  }

  if (process.platform === "linux") {
    const browserCandidates = [
      "google-chrome-stable",
      "google-chrome",
      "chromium",
      "chromium-browser",
      "cachy-browser"
    ];
    for (const candidate of browserCandidates) {
      if (await spawnDetached(candidate, [url.toString()])) return;
    }
  }
  await shell.openExternal(url.toString());
}

function spawnDetached(executable: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, [...args], {
        detached: true,
        stdio: "ignore",
        shell: false
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (launched: boolean): void => {
      if (settled) return;
      settled = true;
      if (launched) child.unref();
      resolve(launched);
    };
    child.once("spawn", () => settle(true));
    child.once("error", () => settle(false));
  });
}

async function ensureDownloadDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await access(directory, fsConstants.W_OK);
}

async function updateSettings(rawPatch: unknown): Promise<AppSettings> {
  const patch = validateSettingsPatch(rawPatch);
  const previous = settingsStore.get();
  const next = settingsStore.preview(patch);

  try {
    await ensureDownloadDirectory(next.downloadDirectory);
  } catch (error) {
    throw new Error("The selected download folder could not be created or written to.", { cause: error });
  }

  if (next.serverPort !== previous.serverPort) {
    try {
      await integrationServer.restart(integrationOptions(next.serverPort));
    } catch (error) {
      try {
        await integrationServer.restart(integrationOptions(previous.serverPort));
      } catch (recoveryError) {
        console.error(`Could not restore the extension service on port ${previous.serverPort}:`, recoveryError);
        throw new Error(`Ports ${next.serverPort} and ${previous.serverPort} are unavailable. Browser capture is currently offline.`, { cause: error });
      }
      throw new Error(`Port ${next.serverPort} is unavailable. The extension service is still using ${previous.serverPort}.`, { cause: error });
    }
  }

  let saved: AppSettings;
  try {
    saved = await settingsStore.update(patch);
  } catch (error) {
    if (next.serverPort !== previous.serverPort) {
      try {
        await integrationServer.restart(integrationOptions(previous.serverPort));
      } catch (recoveryError) {
        console.error(`Could not restore the extension service on port ${previous.serverPort}:`, recoveryError);
      }
    }
    throw error;
  }
  downloadManager.setMaxConcurrent(saved.maxConcurrent);
  return saved;
}

async function openExtensionDirectory(): Promise<void> {
  const directory = extensionDirectory();
  if (app.isPackaged) {
    try {
      await access(directory, fsConstants.R_OK);
    } catch (error) {
      throw new Error("The packaged Chrome extension folder could not be found.", { cause: error });
    }
  } else {
    await mkdir(directory, { recursive: true });
  }
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
}

function registerIpc(): void {
  ipcMain.handle("downloads:list", (event) => {
    assertTrustedIpcSender(event);
    return downloadManager.list();
  });
  ipcMain.handle("downloads:add", (event, input) => {
    assertTrustedIpcSender(event);
    return addDownload(input);
  });
  ipcMain.handle("downloads:pause", (event, id) => {
    assertTrustedIpcSender(event);
    return downloadManager.pause(validateId(id));
  });
  ipcMain.handle("downloads:resume", (event, id) => {
    assertTrustedIpcSender(event);
    return downloadManager.resume(validateId(id));
  });
  ipcMain.handle("downloads:cancel", (event, id) => {
    assertTrustedIpcSender(event);
    return downloadManager.cancel(validateId(id), { deleteFiles: true });
  });
  ipcMain.handle("downloads:remove", (event, id, deleteFile = false) => {
    assertTrustedIpcSender(event);
    if (typeof deleteFile !== "boolean") throw new Error("deleteFile must be true or false.");
    return downloadManager.remove(validateId(id), { deleteFile });
  });
  ipcMain.handle("downloads:open-file", async (event, id) => {
    assertTrustedIpcSender(event);
    const record = findRecord(validateId(id));
    if (record.status !== "completed") throw new Error("The file is not ready yet.");
    const error = await shell.openPath(record.destination);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle("downloads:open-folder", async (event, id) => {
    assertTrustedIpcSender(event);
    const record = findRecord(validateId(id));
    if (record.status === "completed") {
      shell.showItemInFolder(record.destination);
    } else {
      const error = await shell.openPath(path.dirname(record.destination));
      if (error) throw new Error(error);
    }
    return true;
  });
  ipcMain.handle("downloads:open-in-browser", async (event, id) => {
    assertTrustedIpcSender(event);
    const record = findRecord(validateId(id));
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      throw new Error("The original download link is invalid.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS download links can be opened in the browser.");
    }
    await openUrlInChrome(url);
    return true;
  });
  ipcMain.handle("settings:get", (event) => {
    assertTrustedIpcSender(event);
    return { ...settingsStore.get(), appVersion: app.getVersion() };
  });
  ipcMain.handle("settings:update", (event, patch) => {
    assertTrustedIpcSender(event);
    return updateSettings(patch);
  });
  ipcMain.handle("dialog:download-directory", async (event) => {
    assertTrustedIpcSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new Error("The application window is no longer available.");
    const result = await dialog.showOpenDialog(owner, {
      title: "Choose a download folder",
      defaultPath: settingsStore.get().downloadDirectory,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("extension:open-folder", async (event) => {
    assertTrustedIpcSender(event);
    await openExtensionDirectory();
    return true;
  });
  ipcMain.handle("window:minimize", (event) => {
    assertTrustedIpcSender(event);
    mainWindow?.minimize();
  });
  ipcMain.handle("capture:respond", async (event, input) => {
    assertTrustedIpcSender(event);
    const response = validateCaptureResponse(input);
    try {
      const capture = await captureBroker.respond(response);
      if (!capture) throw new Error("Capture not found.");
      return capture;
    } finally {
      if (captureBroker.get(response.id)?.state !== "pending") {
        pendingCaptureEvents.delete(response.id);
        deliveredCaptureEvents.delete(response.id);
      }
    }
  });
}

function installMenu(): void {
  const viewItems: MenuItemConstructorOptions[] = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" }
  ];
  if (!app.isPackaged && process.argv.includes("--dev")) {
    viewItems.unshift(
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" }
    );
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "Add download", accelerator: "CmdOrCtrl+N", click: () => mainWindow?.webContents.send("app:command", "add") },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: viewItems
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Chrome extension folder",
          click: () => void openExtensionDirectory().catch((error) => {
            dialog.showErrorBox("Could not open extension folder", error instanceof Error ? error.message : String(error));
          })
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return;

  rendererReady = false;
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0f1220",
    icon: path.join(app.getAppPath(), "assets", "bunni-logo.png"),
    title: "Bunni Download Manager",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      devTools: !app.isPackaged && process.argv.includes("--dev"),
      nodeIntegration: false,
      safeDialogs: true,
      sandbox: true
    }
  });
  mainWindow = window;

  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("did-start-loading", () => {
    if (mainWindow === window) {
      rendererReady = false;
      deliveredCaptureEvents.clear();
    }
  });
  window.webContents.on("did-finish-load", () => {
    if (mainWindow !== window || window.isDestroyed()) return;
    rendererReady = true;
    flushCaptureRequests();
  });
  window.webContents.on("render-process-gone", () => {
    if (mainWindow === window) rendererReady = false;
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      rendererReady = false;
      deliveredCaptureEvents.clear();
    }
  });
  await window.loadFile(rendererFile());
}

function focusWindow(): void {
  if (shuttingDown) return;
  if (!initialized || !app.isReady()) {
    focusWhenReady = true;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow().catch((error) => {
      dialog.showErrorBox("Could not open Bunni", error instanceof Error ? error.message : String(error));
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleProtocolUrl(value: string): void {
  try {
    const protocolUrl = new URL(value);
    if (protocolUrl.protocol !== `${APP_PROTOCOL}:`) return;
    const downloadUrl = protocolUrl.searchParams.get("url");
    if (!downloadUrl) return;
    focusWindow();
    void addDownload({ url: downloadUrl }).catch((error) => {
      dialog.showErrorBox("Could not add download", error instanceof Error ? error.message : String(error));
    });
  } catch {
    // Ignore malformed protocol invocations.
  }
}

function queueOrHandleProtocolUrl(value: string): void {
  if (!initialized) {
    if (pendingProtocolUrls.length < 20 && !pendingProtocolUrls.includes(value)) pendingProtocolUrls.push(value);
    focusWhenReady = true;
    return;
  }
  handleProtocolUrl(value);
}

function protocolUrlFromArgs(args: string[]): string | undefined {
  return args.find((argument) => argument.toLowerCase().startsWith(`${APP_PROTOCOL}:`));
}

async function initialize(): Promise<void> {
  const dataDirectory = app.getPath("userData");
  const defaults: AppSettings = {
    downloadDirectory: app.getPath("downloads"),
    defaultSegments: 8,
    maxConcurrent: 3,
    serverPort: DEFAULT_PORT,
    notifyOnComplete: true
  };

  settingsStore = new SettingsStore(dataDirectory, defaults);
  await settingsStore.init();
  let settings = settingsStore.get();
  try {
    await ensureDownloadDirectory(settings.downloadDirectory);
  } catch (error) {
    console.error(`Could not use configured download directory ${settings.downloadDirectory}; reverting to Downloads:`, error);
    await ensureDownloadDirectory(defaults.downloadDirectory);
    settings = await settingsStore.update({ downloadDirectory: defaults.downloadDirectory });
  }

  const credentialProtection = createCredentialProtection(safeStorage);
  downloadManager = new DownloadManager({
    dataDir: path.join(dataDirectory, "downloads"),
    downloadDir: settings.downloadDirectory,
    maxConcurrent: settings.maxConcurrent,
    defaultSegments: settings.defaultSegments,
    protectSensitiveHeaders: credentialProtection.protectSensitiveHeaders,
    unprotectSensitiveHeaders: credentialProtection.unprotectSensitiveHeaders
  });
  await downloadManager.init();
  downloadManager.on("changed", broadcastDownloads);
  downloadManager.on("progress", broadcastDownloads);
  downloadManager.on("removed", broadcastDownloads);

  captureBroker = new CaptureBroker<ExtensionDownloadRequest, DownloadRecord>({
    createPaused: (input) => addDownload(input, { startPaused: true }),
    retarget: (id, target) => downloadManager.retarget(id, target),
    resume: (id) => downloadManager.resume(id),
    remove: (id) => downloadManager.remove(id, { deleteFile: false }),
    onRequested: requestCapture,
    onChanged: (capture) => {
      if (capture.state !== "pending") {
        pendingCaptureEvents.delete(capture.id);
        deliveredCaptureEvents.delete(capture.id);
      }
    },
    onError: (error) => console.error("Browser capture cleanup failed:", error)
  });

  integrationServer = new IntegrationServer(integrationOptions());
  try {
    await integrationServer.start();
  } catch (error) {
    console.error(`Could not start Chrome extension service on port ${settings.serverPort}:`, error);
  }

  registerIpc();
  installMenu();
  await createWindow();
  broadcastDownloads();

  const initialProtocolUrl = protocolUrlFromArgs(process.argv);
  if (initialProtocolUrl && !pendingProtocolUrls.includes(initialProtocolUrl)) pendingProtocolUrls.push(initialProtocolUrl);
  initialized = true;
  const queuedProtocolUrls = pendingProtocolUrls.splice(0);
  queuedProtocolUrls.forEach(handleProtocolUrl);
  if (focusWhenReady) {
    focusWhenReady = false;
    focusWindow();
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("com.bunni.downloadmanager");
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }

  app.on("second-instance", (_event, commandLine) => {
    focusWindow();
    const protocolUrl = protocolUrlFromArgs(commandLine);
    if (protocolUrl) queueOrHandleProtocolUrl(protocolUrl);
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    queueOrHandleProtocolUrl(url);
  });

  app.whenReady().then(initialize).catch((error) => {
    console.error(error);
    dialog.showErrorBox("Bunni Download Manager could not start", error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    initialized = false;
    event.preventDefault();
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
    }

    const forcedExit = setTimeout(() => {
      console.error("Bunni shutdown timed out; forcing the application to exit.");
      app.exit(1);
    }, 15_000);
    const orderlyShutdown = async (): Promise<void> => {
      await integrationServer?.stop();
      await captureBroker?.shutdown();
      await downloadManager?.shutdown();
    };
    void Promise.allSettled([orderlyShutdown()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("Bunni shutdown error:", result.reason);
      }
      clearTimeout(forcedExit);
      app.exit(0);
    });
  });
}
