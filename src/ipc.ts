import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface SshHost {
  host: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export const listSshHosts = () => invoke<SshHost[]>("list_ssh_hosts");

export const ptySpawn = (
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
) => invoke<void>("pty_spawn", { id, host, session, rows, cols });

export const ptyWrite = (id: string, data: string) =>
  invoke<void>("pty_write", { id, data });

export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

export const fsListDir = (host: string | null, path: string) =>
  invoke<DirEntry[]>("fs_list_dir", { host, path });

export const fsReadFile = (host: string | null, path: string) =>
  invoke<string>("fs_read_file", { host, path });

export const fsWriteFile = (host: string | null, path: string, content: string) =>
  invoke<void>("fs_write_file", { host, path, content });

export const fsHomeDir = (host: string | null) =>
  invoke<string>("fs_home_dir", { host });

export const fsMkdir = (host: string | null, path: string) =>
  invoke<void>("fs_mkdir", { host, path });

export const fsCreateFile = (host: string | null, path: string) =>
  invoke<void>("fs_create_file", { host, path });

export interface PathInfo {
  exists: boolean;
  is_dir: boolean;
}

/** Reads a file as base64 — used by the image viewer (works for ssh pods). */
export const fsReadBase64 = (host: string | null, path: string) =>
  invoke<string>("fs_read_base64", { host, path });

export const fsStat = (host: string | null, path: string) =>
  invoke<PathInfo>("fs_stat", { host, path });

/** Copies the file into ~/Downloads and resolves with the saved path. */
export const fsDownload = (host: string | null, path: string) =>
  invoke<string>("fs_download", { host, path });

export const fsUpload = (host: string | null, path: string, data: ArrayBuffer) =>
  invoke<void>("fs_upload", new Uint8Array(data), {
    headers: {
      "x-host": host ?? "",
      "x-path": encodeURIComponent(path),
    },
  });

export const onPtyOutput = (
  cb: (payload: { id: string; data: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; data: string }>("pty-output", (e) => cb(e.payload));

export const onPtyExit = (
  cb: (payload: { id: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string }>("pty-exit", (e) => cb(e.payload));
