import type { OmniApi } from "../electron/preload";

declare global {
  interface Window {
    omni: OmniApi;
  }
}

const { invoke, send, on } = window.omni;

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

export const hostStats = (host: string | null) =>
  invoke("host_stats", host) as Promise<HostStats>;

export const listSshHosts = () => invoke("list_ssh_hosts") as Promise<SshHost[]>;

// Terminal traffic is fire-and-forget: awaiting a reply for every keystroke and
// every resize would only add latency to the pty round trip.
export const ptySpawn = (
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
) => {
  send("pty_spawn", id, host, session, rows, cols);
  return Promise.resolve();
};

export const ptyWrite = (id: string, data: string) => {
  send("pty_write", id, data);
  return Promise.resolve();
};

export const ptyResize = (id: string, rows: number, cols: number) => {
  send("pty_resize", id, rows, cols);
  return Promise.resolve();
};

export const ptyKill = (id: string) => {
  send("pty_kill", id);
  return Promise.resolve();
};

/** Epoch seconds when the pod's tmux session was created, if it has one. */
export const tmuxSessionStarted = (host: string | null, session: string) =>
  invoke("tmux_session_started", host, session) as Promise<number | null>;

export const fsListDir = (host: string | null, path: string) =>
  invoke("fs_list_dir", host, path) as Promise<DirEntry[]>;

export const fsReadFile = (host: string | null, path: string) =>
  invoke("fs_read_file", host, path) as Promise<string>;

export const fsWriteFile = (host: string | null, path: string, content: string) =>
  invoke("fs_write_file", host, path, content) as Promise<void>;

export const fsHomeDir = (host: string | null) =>
  invoke("fs_home_dir", host) as Promise<string>;

export const fsMkdir = (host: string | null, path: string) =>
  invoke("fs_mkdir", host, path) as Promise<void>;

export const fsCreateFile = (host: string | null, path: string) =>
  invoke("fs_create_file", host, path) as Promise<void>;

/** Reads a file as base64 — used by the image viewer (works for ssh pods). */
export const fsReadBase64 = (host: string | null, path: string) =>
  invoke("fs_read_base64", host, path) as Promise<string>;

export const fsStat = (host: string | null, path: string) =>
  invoke("fs_stat", host, path) as Promise<PathInfo>;

/** Copies the file into ~/Downloads and resolves with the saved path. */
export const fsDownload = (host: string | null, path: string) =>
  invoke("fs_download", host, path) as Promise<string>;

export const fsUpload = (host: string | null, path: string, data: ArrayBuffer) =>
  invoke("fs_upload", host, path, new Uint8Array(data)) as Promise<void>;

export const onPtyOutput = async (
  cb: (payload: { id: string; data: string }) => void,
): Promise<UnlistenFn> => on("pty-output", cb);

export const onPtyExit = async (
  cb: (payload: { id: string }) => void,
): Promise<UnlistenFn> => on("pty-exit", cb);
