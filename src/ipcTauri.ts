import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "./ipc";

/** Tauri's command layer: named arguments, events over the webview bridge. */
export const tauriBackend: Backend = {
  call: (command, args) => invoke(command, args),
  on: (event, cb) => {
    const pending = listen<never>(event, (e) => cb(e.payload));
    return () => {
      pending.then((un) => un()).catch(() => {});
    };
  },
  upload: (host, path, data) =>
    invoke("fs_upload", new Uint8Array(data), {
      headers: { "x-host": host ?? "", "x-path": encodeURIComponent(path) },
    }),
};
