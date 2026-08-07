import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { join } from "node:path";
import * as files from "./files";
import {
  killTmuxSession,
  renameTmuxSession,
  listTmuxSessions,
  killAllPtys,
  killPty,
  resizePty,
  selectTmuxWindow,
  spawnPty,
  tmuxSessionStarted,
  writePty,
} from "./pty";
import { listSshHosts } from "./sshConfig";

/** Vite dev server, when running `npm run dev`. */
const devUrl = process.env.VITE_DEV_SERVER_URL;

// A dev run has no bundle to read the name from, so the menu bar would say
// "Electron". Set it before anything builds a menu.
app.setName("OmniAgent");

/**
 * The macOS application menu. Without one, Electron installs a default menu
 * titled after the executable — and the standard editing shortcuts the editor
 * and terminal rely on (⌘C/⌘V/⌘A) come from these roles.
 */
function buildMenu() {
  app.setAboutPanelOptions({
    applicationName: "OmniAgent",
    applicationVersion: app.getVersion(),
    // Which runtime this build rides on, since that is the whole reason the
    // app moved off WKWebView.
    version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    copyright: "MIT · github.com/sbyoun/OmniAgent",
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "OmniAgent",
        submenu: [
          { role: "about", label: "About OmniAgent" },
          { type: "separator" },
          { role: "hide", label: "Hide OmniAgent" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "Quit OmniAgent" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
      {
        label: "Help",
        submenu: [
          {
            label: "Project on GitHub",
            click: () => shell.openExternal("https://github.com/sbyoun/OmniAgent"),
          },
        ],
      },
    ]),
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0e0e0e",
    // The app draws its own header; keep the traffic lights where the Tauri
    // build had them so the layout is unchanged.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    title: "OmniAgent — Control Tower",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Nothing may replace the app in this window. The preload is attached to
  // the window, not to a page, so a remote site loaded here would be handed
  // `window.omni` — pty, ssh and the filesystem. Links go to the browser.
  const external = (url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", (e, url) => {
    const here = devUrl ?? "file://";
    if (url.startsWith(here)) return;
    e.preventDefault();
    external(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });

  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, "../dist/index.html"));
}

app.whenReady().then(() => {
  buildMenu();
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Leave the tmux sessions running — they are what the next launch restores —
// but never leave stray ssh/shell clients behind.
app.on("before-quit", killAllPtys);

function registerHandlers() {
  ipcMain.handle("list_ssh_hosts", () => listSshHosts());

  ipcMain.on(
    "pty_spawn",
    (
      e,
      id: string,
      host: string | null,
      session: string | null,
      rows: number,
      cols: number,
      ownsSession: boolean,
    ) => spawnPty(e.sender, id, host, session, rows, cols, ownsSession),
  );
  ipcMain.on("pty_write", (_e, id: string, data: string) => writePty(id, data));
  ipcMain.on("pty_resize", (_e, id: string, rows: number, cols: number) =>
    resizePty(id, rows, cols),
  );
  ipcMain.on("pty_kill", (_e, id: string) => killPty(id));
  ipcMain.handle("tmux_session_started", (_e, host: string | null, session: string) =>
    tmuxSessionStarted(host, session),
  );

  ipcMain.handle("fs_list_dir", (_e, host: string | null, path: string) =>
    files.listDir(host, path),
  );
  ipcMain.handle("fs_read_file", (_e, host: string | null, path: string) =>
    files.readFile(host, path),
  );
  ipcMain.handle(
    "fs_write_file",
    (_e, host: string | null, path: string, content: string) =>
      files.writeFile(host, path, content),
  );
  ipcMain.handle("fs_mkdir", (_e, host: string | null, path: string) =>
    files.mkdir(host, path),
  );
  ipcMain.handle("fs_create_file", (_e, host: string | null, path: string) =>
    files.createFile(host, path),
  );
  ipcMain.handle(
    "fs_upload",
    (_e, host: string | null, path: string, data: Uint8Array) =>
      files.upload(host, path, data),
  );
  ipcMain.handle("fs_download", (_e, host: string | null, path: string) =>
    files.download(host, path),
  );
  ipcMain.handle("fs_read_base64", (_e, host: string | null, path: string) =>
    files.readBase64(host, path),
  );
  ipcMain.handle("fs_stat", (_e, host: string | null, path: string) =>
    files.stat(host, path),
  );
  ipcMain.handle("fs_home_dir", (_e, host: string | null) => files.homeDir(host));
  ipcMain.handle("host_stats", (_e, host: string | null) => files.hostStats(host));

  ipcMain.handle("tmux_sessions", (_e, host: string | null) => listTmuxSessions(host));
  ipcMain.handle("tmux_kill_session", (_e, host: string | null, name: string) =>
    killTmuxSession(host, name),
  );
  ipcMain.handle(
    "tmux_rename_session",
    (_e, host: string | null, from: string, to: string) =>
      renameTmuxSession(host, from, to),
  );
  ipcMain.handle(
    "tmux_select_window",
    (_e, host: string | null, session: string, index: number) =>
      selectTmuxWindow(host, session, index),
  );
  ipcMain.handle("open_external", (_e, url: string) =>
    /^https?:/i.test(url) ? shell.openExternal(url) : undefined,
  );
  ipcMain.handle("layout_read", () => files.readLayout());
  ipcMain.handle("layout_write", (_e, content: string) => files.writeLayout(content));
}
