import { contextBridge, ipcRenderer } from "electron";

type Listener = (payload: unknown) => void;

const subscribe = (channel: string, listener: Listener): (() => void) => {
  if (typeof listener !== "function") throw new TypeError("An event listener function is required.");
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("bunni", Object.freeze({
  list: () => ipcRenderer.invoke("downloads:list"),
  add: (input: unknown) => ipcRenderer.invoke("downloads:add", input),
  pause: (id: string) => ipcRenderer.invoke("downloads:pause", id),
  resume: (id: string) => ipcRenderer.invoke("downloads:resume", id),
  cancel: (id: string) => ipcRenderer.invoke("downloads:cancel", id),
  remove: (id: string, deleteFile = false) => ipcRenderer.invoke("downloads:remove", id, deleteFile),
  openFile: (id: string) => ipcRenderer.invoke("downloads:open-file", id),
  openFolder: (id: string) => ipcRenderer.invoke("downloads:open-folder", id),
  openInBrowser: (id: string) => ipcRenderer.invoke("downloads:open-in-browser", id),
  chooseDownloadDirectory: () => ipcRenderer.invoke("dialog:download-directory"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  openExtensionFolder: () => ipcRenderer.invoke("extension:open-folder"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  respondToCapture: (input: unknown) => ipcRenderer.invoke("capture:respond", input),
  onChanged: (listener: Listener) => subscribe("downloads:changed", listener),
  onStats: (listener: Listener) => subscribe("downloads:stats", listener),
  onCommand: (listener: Listener) => subscribe("app:command", listener),
  onCaptureRequested: (listener: Listener) => subscribe("capture:requested", listener)
}));
