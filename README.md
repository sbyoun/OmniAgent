# OmniAgent

**A control tower for your AI agent fleet.**

![OmniAgent — agents working across a fleet of servers in one pod grid](assets/screenshot.png)

OmniAgent is a native desktop terminal built for one job: running and monitoring
CLI coding agents (Claude Code, aider, Codex CLI, …) across all of your machines
at once. Every server becomes a *pod* in a tiled grid — each pod a live terminal
with its own file explorer and code editor a single click away.

> Terminal is the main. Editor is the modal.

## Why

Existing tools cover halves of this problem:

- **Agent dashboards** (tmux-based TUIs) monitor agents — but only inside one
  machine's tmux.
- **SSH terminal managers** handle many servers — but know nothing about
  long-running agent sessions.

OmniAgent does both: zero-config SSH fleet discovery, persistent agent sessions,
and a control-tower UI designed for watching many agents work in parallel.

### How it compares

| | Terminal grid | SSH manager | Explorer + editor **per terminal** | Sessions restore **with content** | Agent fleet focus |
|---|:-:|:-:|:-:|:-:|:-:|
| iTerm2 / WezTerm / Warp | ✅ | ➖ | ❌ | manual `tmux -CC` | ❌ |
| Tabby / Termius | ✅ | ✅ | basic SFTP, separate view | ❌ | ❌ |
| MobaXterm *(Windows)* | tabs | ✅ | ✅ | ❌ | ❌ |
| VS Code Remote-SSH | ➖ | one host at a time | ✅ | ❌ | ❌ |
| tmux dashboards (TmuxCC, …) | TUI | ❌ | ❌ | ✅ | ✅ local only |
| **OmniAgent** | ✅ | ✅ zero-config | ✅ docked in every pod | ✅ by default | ✅ across servers |

The last column is where OmniAgent is headed: agent status detection,
needs-input notifications, and fleet-wide agent instructions are the
[current milestone](https://github.com/sbyoun/OmniAgent/milestones).

## Features

- **Zero-config fleet** — your `~/.ssh/config` *is* the server list. No accounts,
  no database, no setup UI.
- **Pod grid multiplexing** — every connection is a pod in a draggable,
  resizable grid (powered by Dockview). Presets: `2×2`, `3-COL`, `FOCUS`.
- **Full session restore** — close the app, reopen it, and every pod comes back:
  same hosts, same layout, same terminal content. Local pods run in per-pod tmux
  sessions; remote pods attach to tmux on the server.
- **On-demand explorer & editor** — toggle a file tree or a Monaco editor inside
  any pod. Remote file access uses one-shot `ssh` commands (your existing keys),
  connected only while you use it. `⌘S` saves straight back to the server.
- **Session lifecycle that makes sense** — `exit` ends the session and closes
  the pod; closing a pod kills its backing session; quitting the app preserves
  everything for next launch.
- **Input that actually works** — the terminal runs on Chromium, deliberately.
  WKWebView drops composed CJK syllables through a race nobody can reproduce on
  demand; [WEBKIT-IME.md](WEBKIT-IME.md) has the measurements.

## Two builds

Every release carries the same app in two shells — one frontend, two
packagings, pick per machine:

| | Files | Runtime | Size |
|---|---|---|---|
| **Electron** | `OmniAgent-electron-*` | Chromium | ~120 MB |
| **Tauri** | `OmniAgent_*` | WKWebView, WebView2, WebKitGTK | ~10 MB |

The Tauri build is a tenth of the size and lighter on memory. The Electron
build is larger, but on macOS its terminal takes Korean, Japanese and Chinese
input reliably — WKWebView drops composed syllables through a timing race that
varies by machine and by launch, which the Tauri build can only paper over.
[WEBKIT-IME.md](WEBKIT-IME.md) has the measurements. If you type CJK in the
terminal on macOS, take the Electron build; otherwise either is fine.

```
src/           the app — shared, unaware of which shell it is in
src/ipc.ts     picks its backend at runtime
src-tauri/     the Tauri shell (Rust)
electron/      the Electron shell (Node)
```

## Stack

| Layer | Tech |
|---|---|
| Shell | Electron / Tauri 2 |
| PTY | node-pty / portable-pty, both over tmux |
| UI | React 19 + TypeScript + Tailwind CSS 4 |
| Layout | dockview-react |
| Terminal | @xterm/xterm |
| Editor | Monaco |

## Getting started

Requirements: Node.js 20+, and `tmux` (optional, needed for local session
restore; `brew install tmux`).

```bash
git clone https://github.com/sbyoun/OmniAgent.git
cd OmniAgent
npm install

npm run dev            # Vite, in one terminal…
npm run dev:electron   # …the Electron app in another
npm run tauri dev      # or the Tauri app instead

npm run package        # Electron bundle, signed and notarized
npm run package:local  # …the same bundle unsigned, to test on this machine
npm run tauri build    # Tauri bundle
```

Building the Tauri shell also needs [Rust](https://rustup.rs).

On first launch the sidebar lists every concrete `Host` from your
`~/.ssh/config`. Click one (or *Local Terminal*) to launch a pod.

### On Windows

A local pod is a pod in your WSL distro — the distro is the machine. Its `~`,
its files, its `tmux ls`, and its `~/.ssh/config` are the ones you get, because
the `ssh` that runs is the one with the keys next to it. Nothing to configure
if `wsl.exe` starts your default distro; set `OMNIAGENT_WSL_DISTRO` to pick
another. Downloads and the saved layout stay on the Windows side, where
Explorer can find them.

Develop in WSL, build in Windows. `node_modules` holds per-platform binaries,
so one directory cannot serve both — keep a Windows-side copy for building, and
never run `npm ci` against the WSL path from PowerShell.

```bash
# WSL — push the source to the Windows-side build directory
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude dist-electron \
  --exclude dist-test --exclude release --exclude src-tauri/target \
  ~/path/to/OmniAgent/ /mnt/c/path/to/OmniAgent/
```

```powershell
# PowerShell — build the installer
cd C:\path\to\OmniAgent
npm ci                 # first time, and whenever dependencies change
npm run package:win    # → release\OmniAgent-electron-<version>-x64.exe
```

Take the Electron build on Windows; the Tauri shell has not been brought across
yet.

## Status & roadmap

Early but functional — built and daily-driven on macOS. Linux is untested.
Windows runs its pods through WSL, and is newer than the rest.

Development is tracked on the [issue tracker](https://github.com/sbyoun/OmniAgent/issues)
and grouped into [milestones](https://github.com/sbyoun/OmniAgent/milestones):

- **v0.2.0 — Control Tower Core**: [`FLEET.md` unified agent instructions](https://github.com/sbyoun/OmniAgent/issues/1),
  [agent status detection](https://github.com/sbyoun/OmniAgent/issues/2),
  [needs-input notifications](https://github.com/sbyoun/OmniAgent/issues/3)
- **v0.3.0 — Fleet Operations**: [broadcast dispatch](https://github.com/sbyoun/OmniAgent/issues/4),
  [fleet journal](https://github.com/sbyoun/OmniAgent/issues/5),
  [remote named sessions](https://github.com/sbyoun/OmniAgent/issues/6)

Issues and PRs welcome.

## License

[MIT](LICENSE)
