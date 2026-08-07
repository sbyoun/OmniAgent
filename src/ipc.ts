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
  /** Identifies the box, so aliases that reach the same one share a poll. */
  machine: string;
}

export const listSshHosts = () => backend.call<SshHost[]>("list_ssh_hosts");

export const ptySpawn = (
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
  /** False when attaching to a session the app did not create. */
  ownsSession = true,
) =>
  backend.call<void>("pty_spawn", {
    id,
    host,
    session,
    rows,
    cols,
    ownsSession,
    // Rust names it in snake_case.
    owns_session: ownsSession,
  });

export const ptyWrite = (id: string, data: string) =>
  backend.call<void>("pty_write", { id, data });

export const ptyResize = (id: string, rows: number, cols: number) =>
  backend.call<void>("pty_resize", { id, rows, cols });

export const ptyKill = (id: string) => backend.call<void>("pty_kill", { id });

/**
 * Close a pod but leave its tmux session running (⌘/Ctrl+W). Unlike
 * `ptyKill`, the session is never touched — the work stays put and the pod
 * reattaches to it next launch. Must be awaited before the panel is removed so
 * it lands ahead of the teardown's `ptyKill`, which then finds nothing to do.
 */
export const ptyDetach = (id: string) =>
  backend.call<void>("pty_detach", { id });

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

export interface TmuxSession {
  name: string;
  /** Epoch seconds. */
  created: number;
  attached: boolean;
  windows: number;
}

export interface SessionList {
  /** Stable id of the machine behind this alias — several may reach one box. */
  machine: string;
  sessions: TmuxSession[];
}

/** Every tmux session on a machine, the app's own and everyone else's. */
export const tmuxSessions = (host: string | null) =>
  backend.call<SessionList>("tmux_sessions", { host });

/** Renames a session; false when something already has that name. */
export const tmuxRenameSession = (host: string | null, from: string, to: string) =>
  backend.call<boolean>("tmux_rename_session", { host, from, to });

/** Ends a session for good — the work inside it goes with it. */
export const tmuxKillSession = (host: string | null, name: string) =>
  backend.call<void>("tmux_kill_session", { host, name });

/** Brings one of a session's windows to the front — the header's window strip. */
export const tmuxSelectWindow = (
  host: string | null,
  session: string,
  index: number,
) => backend.call<void>("tmux_select_window", { host, session, index });

/** Hands a link to the user's browser. */
export const openExternal = (url: string) =>
  backend.call<void>("open_external", { url });

/** The pod layout, kept in a file both shells read so it survives switching. */
export const layoutRead = () => backend.call<string | null>("layout_read");

export const layoutWrite = (content: string) =>
  backend.call<void>("layout_write", { content });

/** Which shell this build is running in — shown in the header. */
export const shellName = "__TAURI_INTERNALS__" in window ? "Tauri" : "Electron";

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

/** One entry the native Font menu (View → Font) should list. */
export interface FontMenuOption {
  key: string;
  label: string;
}

/**
 * Rebuild the native Font menu to mirror the renderer's font state — the
 * renderer owns the list and the selection (it lives in localStorage), so the
 * menu is only a projection of it. Called on startup and after every change.
 * Best-effort: a shell without a native menu simply ignores the call.
 */
export const setFontMenu = (options: FontMenuOption[], selected: string) =>
  backend.call<void>("set_font_menu", { options, selected }).catch(() => {});

/** The user picked a font in the native menu. Payload is the option's key. */
export const onMenuSetFont = (cb: (key: string) => void): UnlistenFn =>
  backend.on("menu-set-font", cb);

/** The user chose "Add Local Font…" in the native menu. */
export const onMenuAddFont = (cb: () => void): UnlistenFn =>
  backend.on("menu-add-font", cb);

/**
 * Mirror the active-pod-border setting onto View → Active Pod Border. Same
 * arrangement as the font menu: the renderer owns the value, the menu shows it.
 */
export const setPodBorderMenu = (enabled: boolean) =>
  backend.call<void>("set_pod_border_menu", { enabled }).catch(() => {});

/** The user toggled View → Active Pod Border. Payload is the new state. */
export const onMenuSetPodBorder = (cb: (enabled: boolean) => void): UnlistenFn =>
  backend.on("menu-set-pod-border", cb);
