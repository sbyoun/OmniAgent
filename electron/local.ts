/**
 * Where "local" is.
 *
 * On macOS and Linux the app runs on the machine it manages, so a local
 * command is just a command. Windows is not that: it has no tmux to attach to,
 * no login shell worth handing an agent, and none of the ssh keys. All of that
 * lives one layer down, in WSL — so on Windows the local machine IS the WSL
 * distro, and every POSIX command the app runs locally goes through
 * `wsl.exe`: the pod's shell, `tmux ls`, the explorer's `ls`, and `ssh` out to
 * the rest of the fleet too. A pod's `~` is the distro's `~`, and the hosts in
 * the sidebar are the ones in the distro's `~/.ssh/config`, because those are
 * the ones its `ssh` can actually reach.
 *
 * The entire platform difference is the wrapper below. Off Windows
 * `onLocalMachine` hands back exactly the argv it was given, so every call
 * site in `pty.ts` and `files.ts` runs the same command line on macOS and
 * Linux that it ran before this file existed.
 */
import { execFile } from "node:child_process";

export const LOCAL_IS_WSL = process.platform === "win32";

/**
 * Which distro. Unset means whatever `wsl.exe` treats as the default, which is
 * the right answer for anyone who has one; `OMNIAGENT_WSL_DISTRO` names
 * another for anyone who keeps several and works in the second.
 */
const DISTRO = process.env.OMNIAGENT_WSL_DISTRO?.trim();

/**
 * Run this argv on the local machine — through WSL when that is where the
 * local machine is.
 *
 * `-e` is not optional. Without it wsl.exe hands the line to the default shell
 * to parse again, and the pod's `tmux … \; set-option …` does not survive
 * being parsed twice. With `-e` the argv is passed through as given, which
 * also means the multi-line `sh -c` scripts below arrive intact.
 */
export function onLocalMachine(file: string, args: string[]): [string, string[]] {
  if (!LOCAL_IS_WSL) return [file, args];
  return ["wsl.exe", [...(DISTRO ? ["-d", DISTRO] : []), "-e", file, ...args]];
}

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/**
 * argv for one POSIX shell command, on `host` or on the local machine. This is
 * the shape almost every helper in the app wants: one short command, its
 * stdout parsed. On Windows both arms go through WSL — the remote one because
 * the ssh that knows the host is the distro's.
 */
export function shellArgv(host: string | null, command: string): [string, string[]] {
  return host
    ? onLocalMachine("ssh", [...SSH_OPTS, host, command])
    : onLocalMachine("sh", ["-c", command]);
}

/**
 * PATH for helper commands — a GUI launch inherits almost nothing, and the
 * Homebrew prefixes are where a Mac keeps tmux. Windows separates PATH with
 * `;` and finds wsl.exe in System32 regardless, so it is left alone rather
 * than given a `:`-joined entry that means nothing to it.
 */
export const toolPath = LOCAL_IS_WSL
  ? (process.env.PATH ?? "")
  : `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;

/**
 * wsl.exe reports its OWN failures — no distro by that name, WSL not
 * installed, the VM declining to start — in UTF-16, while everything the
 * distro itself prints comes back as the UTF-8 it wrote. Bytes with NULs in
 * them are the former, and reading those as UTF-8 would put `\0t\0h\0e` in
 * front of the user at exactly the moment they need to be told what broke.
 */
export function decodeStderr(buf: Buffer): string {
  return (buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8")).trim();
}

/**
 * Run a POSIX shell command and resolve with its stdout, rejecting with
 * whatever the far side complained about.
 *
 * stdout is captured as bytes and decoded here rather than by `execFile`, so
 * that stderr can be decoded on its own terms (see `decodeStderr`) and so the
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
  const [file, args] = shellArgv(host, command);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: toolPath } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(decodeStderr(stderr) || err.message));
          return;
        }
        resolve(encoding === "buffer" ? stdout : stdout.toString("utf8"));
      },
    );
  });
}
