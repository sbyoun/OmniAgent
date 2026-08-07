import type { Backend } from "./ipc";
import type { OmniApi } from "../electron/preload";

declare global {
  interface Window {
    omni?: OmniApi;
  }
}

/** Electron's IPC: positional arguments over the preload bridge. */
export const electronBackend: Backend = {
  call: (command, args) => {
    const omni = window.omni!;
    // Terminal traffic is fire-and-forget: awaiting a reply for every
    // keystroke and every resize would only add latency to the pty round trip.
    if (command.startsWith("pty_")) {
      omni.send(command, ...positional(command, args));
      return Promise.resolve(undefined as never);
    }
    return omni.invoke(command, ...positional(command, args)) as Promise<never>;
  },
  on: (event, cb) => window.omni!.on(event, cb),
  upload: (host, path, data) =>
    window.omni!.invoke("fs_upload", host, path, new Uint8Array(data)) as Promise<void>,
};

/**
 * Tauri commands take a named record; Electron handlers take arguments in
 * order. The order is the one the handlers in `electron/main.ts` declare.
 */
const ORDER: Record<string, string[]> = {
  pty_spawn: ["id", "host", "session", "rows", "cols", "ownsSession"],
  pty_write: ["id", "data"],
  pty_resize: ["id", "rows", "cols"],
  pty_kill: ["id"],
  tmux_session_started: ["host", "session"],
  fs_list_dir: ["host", "path"],
  fs_read_file: ["host", "path"],
  fs_write_file: ["host", "path", "content"],
  fs_mkdir: ["host", "path"],
  fs_create_file: ["host", "path"],
  fs_download: ["host", "path"],
  fs_read_base64: ["host", "path"],
  fs_stat: ["host", "path"],
  fs_home_dir: ["host"],
  host_stats: ["host"],
  layout_write: ["content"],
  open_external: ["url"],
  tmux_sessions: ["host"],
  tmux_kill_session: ["host", "name"],
  tmux_rename_session: ["host", "from", "to"],
  tmux_select_window: ["host", "session", "index"],
};

function positional(command: string, args?: Record<string, unknown>): unknown[] {
  return (ORDER[command] ?? []).map((key) => args?.[key]);
}
