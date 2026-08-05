/**
 * Dragging the custom title bar.
 *
 * Electron does this from the `-webkit-app-region: drag` style alone, and
 * handles double-click-to-zoom with it. WKWebView ignores that property, so
 * the Tauri build has to ask its own window to start a drag — and the API is
 * only there to import when Tauri is the shell.
 */
export function startWindowDrag(e: React.MouseEvent) {
  if (e.button !== 0 || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    if (e.detail === 2) win.toggleMaximize();
    else win.startDragging();
  });
}
