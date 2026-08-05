import { tauriBackend } from "./ipcTauri";
import { electronBackend } from "./ipcElectron";

/**
 * The frontend is shared by both shells, so it talks to one of these instead
 * of to Tauri or Electron directly. Everything below this line is identical
 * for either build.
 */
export interface Backend {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  on<T>(event: string, cb: (payload: T) => void): () => void;
  /** Raw bytes travel differently in each shell, so uploads get their own door. */
  upload(host: string | null, path: string, data: ArrayBuffer): Promise<void>;
}

/** Tauri injects its internals into the page; Electron exposes a preload API. */
const backend: Backend =
  "__TAURI_INTERNALS__" in window ? tauriBackend : electronBackend;

export type UnlistenFn = () => void;

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

export interface PathInfo {
  exists: boolean;
  is_dir: boolean;
}

export interface HostStats {
  cpu: number;
  mem_used_mb: number;
  mem_total_mb: number;
}

export const listSshHosts = () => backend.call<SshHost[]>("list_ssh_hosts");

export const ptySpawn = (
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
) => backend.call<void>("pty_spawn", { id, host, session, rows, cols });

export const ptyWrite = (id: string, data: string) =>
  backend.call<void>("pty_write", { id, data });

export const ptyResize = (id: string, rows: number, cols: number) =>
  backend.call<void>("pty_resize", { id, rows, cols });

export const ptyKill = (id: string) => backend.call<void>("pty_kill", { id });

/** Epoch seconds when the pod's tmux session was created, if it has one. */
export const tmuxSessionStarted = (host: string | null, session: string) =>
  backend.call<number | null>("tmux_session_started", { host, session });

export const fsListDir = (host: string | null, path: string) =>
  backend.call<DirEntry[]>("fs_list_dir", { host, path });

export const fsReadFile = (host: string | null, path: string) =>
  backend.call<string>("fs_read_file", { host, path });

export const fsWriteFile = (host: string | null, path: string, content: string) =>
  backend.call<void>("fs_write_file", { host, path, content });

export const fsHomeDir = (host: string | null) =>
  backend.call<string>("fs_home_dir", { host });

export const fsMkdir = (host: string | null, path: string) =>
  backend.call<void>("fs_mkdir", { host, path });

export const fsCreateFile = (host: string | null, path: string) =>
  backend.call<void>("fs_create_file", { host, path });

/** Reads a file as base64 — used by the image viewer (works for ssh pods). */
export const fsReadBase64 = (host: string | null, path: string) =>
  backend.call<string>("fs_read_base64", { host, path });

export const fsStat = (host: string | null, path: string) =>
  backend.call<PathInfo>("fs_stat", { host, path });

/** Copies the file into ~/Downloads and resolves with the saved path. */
export const fsDownload = (host: string | null, path: string) =>
  backend.call<string>("fs_download", { host, path });

export const hostStats = (host: string | null) =>
  backend.call<HostStats>("host_stats", { host });

export const fsUpload = (host: string | null, path: string, data: ArrayBuffer) =>
  backend.upload(host, path, data);

export const onPtyOutput = async (
  cb: (payload: { id: string; data: string }) => void,
): Promise<UnlistenFn> => backend.on("pty-output", cb);

export const onPtyExit = async (
  cb: (payload: { id: string }) => void,
): Promise<UnlistenFn> => backend.on("pty-exit", cb);
