/**
 * Where "local" is.
 *
 * On macOS and Linux the app runs on the machine it manages, so a local
 * command is just a command. Windows is not one machine but two, and which one
 * is "local" is decided here, once, at startup:
 *
 * - `wsl`: a WSL distro is installed, so the local machine IS the distro — its
 *   `~`, its `tmux ls`, its files. Every POSIX command the app runs locally
 *   goes through `wsl.exe`. This is what gives a Windows local pod the same
 *   session restore a Mac has: tmux has no Windows port, and the distro is
 *   where one lives.
 * - `native`: no distro. The local pod is a PowerShell running under ConPTY,
 *   with no tmux behind it and so no content restore across launches; the
 *   explorer reads the Windows filesystem directly. Everything works except
 *   the one feature that needs tmux, instead of nothing working at all.
 *
 * ssh is separate from that choice and, on Windows, native by default: the
 * OpenSSH that ships with Windows reads `C:\Users\you\.ssh\config` and the
 * keys beside it, and the remote pod's tmux runs on the server anyway, so the
 * distro adds nothing but a dependency. `OMNIAGENT_SSH=wsl` routes ssh through
 * the distro for anyone whose keys live there instead.
 *
 * Off Windows every wrapper below hands back exactly the argv it was given, so
 * every call site in `pty.ts` and `files.ts` runs the same command line on
 * macOS and Linux that it ran before this file existed.
 */
import { execFile } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";

/** What a `host: null` command runs on. Fixed for the life of the process. */
export type LocalMode = "posix" | "wsl" | "native";

/**
 * Which distro. Unset means whatever `wsl.exe` treats as the default, which is
 * the right answer for anyone who has one; `OMNIAGENT_WSL_DISTRO` names
 * another for anyone who keeps several and works in the second. Naming one is
 * also a statement that WSL is wanted, so it skips detection.
 */
const DISTRO = process.env.OMNIAGENT_WSL_DISTRO?.trim() || undefined;

/**
 * `OMNIAGENT_LOCAL=wsl|native` forces the mode — for a machine where detection
 * gets it wrong, and for the argv tests, which have no wsl.exe to ask.
 */
function forcedMode(): LocalMode | undefined {
  const v = process.env.OMNIAGENT_LOCAL?.trim().toLowerCase();
  return v === "wsl" || v === "native" ? v : undefined;
}

/**
 * The initial answer is synchronous so module-level code can rely on it; on a
 * Windows box with nothing forced it starts as `native` and `detectLocal()`
 * upgrades it to `wsl` before the first window opens.
 */
let mode: LocalMode = !IS_WINDOWS ? "posix" : forcedMode() ?? (DISTRO ? "wsl" : "native");

export const localMode = (): LocalMode => mode;
export const localIsWsl = (): boolean => mode === "wsl";
/** Windows with no distro: no `sh`, no `tmux`, PowerShell pods. */
export const localIsNativeWindows = (): boolean => mode === "native";

/**
 * Ask wsl.exe whether there is a distro to be local in. `-l -q` prints one
 * distro name per line, in UTF-16, and nothing at all when WSL is installed
 * but empty; a machine without WSL fails the call outright. Either of the
 * latter leaves the mode at `native`.
 */
export function detectLocal(): Promise<LocalMode> {
  if (!IS_WINDOWS || forcedMode() || DISTRO) return Promise.resolve(mode);
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      ["-l", "-q"],
      { encoding: "buffer", timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const names = decodeConsole(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!err && names.length > 0) mode = "wsl";
        resolve(mode);
      },
    );
  });
}

/**
 * Run this argv on the local machine — through WSL when that is where the
 * local machine is.
 *
 * `-e` is not optional. Without it wsl.exe hands the line to the default shell
 * to parse again, and the pod's `tmux … \; set-option …` does not survive
 * being parsed twice. With `-e` the argv is passed through as given, which
 * also means the multi-line `sh -c` scripts elsewhere arrive intact.
 */
export function onLocalMachine(file: string, args: string[]): [string, string[]] {
  if (!localIsWsl()) return [file, args];
  return ["wsl.exe", [...(DISTRO ? ["-d", DISTRO] : []), "-e", file, ...args]];
}

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/**
 * For a one-shot command whose stdin nobody will write to: `-n` keeps ssh from
 * reading it at all. Not decoration on Windows — its OpenSSH does not exit
 * after the remote command finishes while stdin is a pipe left open, which is
 * exactly what `execFile` hands it, so every `tmux ls` poll would hang forever
 * (and with it the pod that was waiting to learn whether its session was
 * still alive). Not for `pipe()`, whose whole job is to feed stdin, nor for a
 * pod, whose stdin is the user.
 */
export const SSH_ONESHOT = [...SSH_OPTS, "-n"];

/**
 * Whether ssh should be the distro's rather than Windows' own OpenSSH. Read
 * once, like every other knob here: the answer must not change under a pod
 * that is already open.
 */
const SSH_VIA_WSL = process.env.OMNIAGENT_SSH?.trim().toLowerCase() === "wsl";
export const sshViaWsl = (): boolean => localIsWsl() && SSH_VIA_WSL;

/**
 * The ssh program by the name node-pty can start. `execFile` and a shell both
 * find `ssh` on Windows by trying `.exe` for you; node-pty's ConPTY spawner
 * does not, and a pod asked to run bare `ssh` died before it began with
 * "File not found" — surfaced as Electron's main-process error dialog, since
 * `pty_spawn` has no reply to carry it. Inside the distro it is plain `ssh`.
 */
const SSH = IS_WINDOWS ? "ssh.exe" : "ssh";

/**
 * argv for an ssh invocation. Native everywhere by default — on Windows that
 * is `C:\Windows\System32\OpenSSH\ssh.exe`, which knows the user's own
 * `~/.ssh/config`; see `sshViaWsl` for the exception.
 */
export function sshArgv(args: string[]): [string, string[]] {
  return sshViaWsl() ? onLocalMachine("ssh", args) : [SSH, args];
}

/**
 * argv for one POSIX shell command, on `host` or on the local machine. This is
 * the shape almost every helper in the app wants: one short command, its
 * stdout parsed. The local arm has no meaning in `native` mode — there is no
 * `sh` — and callers are expected to have branched before getting here; `run`
 * below makes the mistake loud rather than letting Windows fail to find `sh`.
 */
export function shellArgv(host: string | null, command: string): [string, string[]] {
  return host
    ? sshArgv([...SSH_ONESHOT, host, command])
    : onLocalMachine("sh", ["-c", command]);
}

/**
 * PATH for helper commands — a GUI launch inherits almost nothing, and the
 * Homebrew prefixes are where a Mac keeps tmux. Windows separates PATH with
 * `;` and finds wsl.exe and ssh.exe in System32 regardless, so it is left
 * alone rather than given a `:`-joined entry that means nothing to it.
 */
export const toolPath = IS_WINDOWS
  ? (process.env.PATH ?? "")
  : `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;

/**
 * Windows console programs — wsl.exe reporting its OWN failures, or listing
 * distros — write UTF-16 when their output is a pipe, while everything a
 * distro or an ssh server prints comes back as the UTF-8 it wrote. Bytes with
 * NULs in them are the former, and reading those as UTF-8 would put `\0t\0h\0e`
 * in front of the user at exactly the moment they need to be told what broke.
 */
export function decodeConsole(buf: Buffer): string {
  return (buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8")).trim();
}

/** @deprecated name kept for the call sites that only ever see stderr. */
export const decodeStderr = decodeConsole;

/**
 * Run a POSIX shell command and resolve with its stdout, rejecting with
 * whatever the far side complained about.
 *
 * stdout is captured as bytes and decoded here rather than by `execFile`, so
 * that stderr can be decoded on its own terms (see `decodeConsole`) and so the
 * callers that want raw file contents get them unmangled. On macOS and Linux
 * that is the same string `execFile`'s own `utf8` would have produced.
 */
export function run(host: string | null, command: string, encoding: "utf8"): Promise<string>;
export function run(host: string | null, command: string, encoding: "buffer"): Promise<Buffer>;
export function run(
  host: string | null,
  command: string,
  encoding: "utf8" | "buffer",
): Promise<string | Buffer> {
  if (!host && localIsNativeWindows()) {
    return Promise.reject(
      new Error("no POSIX shell on this machine (Windows without WSL); local calls must use the native path"),
    );
  }
  const [file, args] = shellArgv(host, command);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PATH: toolPath },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(decodeConsole(stderr) || err.message));
          return;
        }
        resolve(encoding === "buffer" ? stdout : stdout.toString("utf8"));
      },
    );
  });
}
