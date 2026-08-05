Two builds of the same app — take either one.

| | Files | Runtime | Size |
|---|---|---|---|
| **Electron** | `OmniAgent-electron-*` | Chromium | ~120 MB |
| **Tauri** | `OmniAgent_*` | WKWebView / WebView2 / WebKitGTK | ~10 MB |

The Tauri build is a tenth of the size and lighter on memory. The Electron
build is larger, but on macOS its terminal takes **Korean, Japanese and
Chinese input reliably** — WKWebView drops composed syllables through a timing
race that varies by machine and by launch.
[WEBKIT-IME.md](https://github.com/sbyoun/OmniAgent/blob/main/WEBKIT-IME.md)
has the measurements.

If you type CJK in the terminal on macOS, take the Electron build; otherwise
either is fine.

macOS builds are signed and notarized, so they open without the Gatekeeper
detour.
