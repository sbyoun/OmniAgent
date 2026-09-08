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

Remote pods are native: the OpenSSH that ships with Windows, your
`C:\Users\you\.ssh\config`, and the keys beside it. The tmux behind a remote
pod runs on the server, so nothing else is needed — the sidebar fills from that
file and every ssh pod works exactly as on a Mac.

The local pod depends on whether you have WSL, because tmux has no Windows
port and tmux is what makes a pod's content survive a relaunch:

- **With a WSL distro** — the local pod is a pod *in the distro*: its `~`, its
  files, its `tmux ls`, with full session restore. Nothing to configure if
  `wsl.exe` starts your default distro; `OMNIAGENT_WSL_DISTRO` picks another.
- **Without WSL** — the local pod is PowerShell (`pwsh` if installed, else
  Windows PowerShell; `OMNIAGENT_SHELL` overrides). Everything works except
  restore: the pod comes back empty after a relaunch, like a Mac without tmux.

Detected once at startup; `OMNIAGENT_LOCAL=wsl|native` forces it. If your ssh
keys live in the distro rather than on the Windows side, `OMNIAGENT_SSH=wsl`
routes ssh through it too. Downloads and the saved layout stay on the Windows
side, where Explorer can find them.

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

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

Windows binaries on the [releases page](https://github.com/sbyoun/OmniAgent/releases)
are signed with a SignPath Foundation certificate. Every release is built by
the [Release workflow](.github/workflows/release.yml) on GitHub Actions from a
tagged commit of this repository, and each signing request is approved by a
maintainer before the certificate is applied.

Team roles: [@sbyoun](https://github.com/sbyoun) is the committer, reviewer and
approver. Changes from anyone else are reviewed before they are merged.

Privacy: this program will not transfer any information to other networked
systems unless specifically requested by the user — it connects only to the
SSH hosts you choose from your own `~/.ssh/config`.

## Status & roadmap

Early but functional — built and daily-driven on macOS. Linux is untested.
Windows is newer than the rest: remote pods native, local pod in WSL when
there is one and PowerShell when there is not.

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
