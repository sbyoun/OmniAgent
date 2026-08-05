import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * The renderer's whole view of the main process. `src/ipc.ts` is the only
 * module that touches it, so the UI code is unchanged from the Tauri build.
 */
const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  /** Subscribe to a main-process event; returns the unsubscribe function. */
  on: <T>(channel: string, cb: (payload: T) => void) => {
    const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};

contextBridge.exposeInMainWorld("omni", api);

export type OmniApi = typeof api;
