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

On Windows, take the Electron build (`OmniAgent-electron-*.exe`, an
installer): remote pods use Windows' own OpenSSH and `~/.ssh/config`, and the
local pod runs in your WSL distro when you have one, PowerShell when you do
not. The Tauri build still expects WSL for everything.

macOS builds are signed and notarized, so they open without the Gatekeeper
detour.
