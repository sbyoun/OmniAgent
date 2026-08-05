import ReactDOM from "react-dom/client";
import App from "./App";
import { openExternal } from "./ipc";

import "./index.css";

/**
 * Links go to the browser, never into this window.
 *
 * The window is the app: in the Electron build the preload is attached to it
 * rather than to a page, so anything that navigated here would inherit the
 * whole command surface — pty, ssh, the filesystem. Markdown previews and
 * terminal output both produce anchors, and one click was enough.
 */
document.addEventListener("click", (e) => {
  const link = (e.target as Element | null)?.closest?.("a[href]");
  const href = link?.getAttribute("href");
  if (!href || !/^https?:/i.test(href)) return;
  e.preventDefault();
  void openExternal(href).catch(() => {});
});


// No StrictMode: its dev-only double-mount kills and recreates each pod's
// PTY (and backing tmux session), which breaks session restore.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
