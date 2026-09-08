import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import * as pty from "node-pty";
import type { WebContents } from "electron";
import {
  IS_WINDOWS,
  localIsNativeWindows,
  localIsWsl,
  onLocalMachine,
  shellArgv,
  sshArgv,
  SSH_ONESHOT,
  toolPath,
} from "./local";

/**
 * A local pod that has no tmux behind it — a Windows without WSL. Every tmux
 * helper below answers for it without spawning anything: there is no `sh` to
 * spawn, and the honest answer to "which sessions" is none.
 */
const noLocalTmux = (host: string | null) => !host && localIsNativeWindows();

/**
 * The shell a native Windows pod runs. PowerShell 7 when it is installed —
 * it is what people who chose it want — else the Windows PowerShell every
 * machine has. `OMNIAGENT_SHELL` names another (`cmd.exe`, a full path).
 * Resolved once: a GUI launch's PATH does not change afterwards.
 */
const windowsShell: string = (() => {
  const wanted = process.env.OMNIAGENT_SHELL?.trim();
  if (wanted) return wanted;
  const onPath = (exe: string) =>
    (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, exe)));
  return onPath("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
})();

interface Instance {
  proc: pty.IPty;
  /** Host this pod is connected to (null = local). */
  host: string | null;
  /**
   * Name of the tmux session backing this pod. Killed when the pod is
   * explicitly closed so sessions don't accumulate; preserved on app quit so
   * the pod can restore. Cleared the moment the client exits on its own, so a
   * connection that merely dropped can never take the session down with it.
   */
  session: string | null;
  /**
   * Whether this pod created its session. A pod opened onto a session that was
   * already running — from the sessions list — is a guest: closing the pod
   * must leave the work alone.
   */
  ownsSession: boolean;
}

/**
 * A stable id for the machine itself, so the fleet is grouped by box rather
 * than by the route taken to reach it: an `~/.ssh/config` can hold several
 * aliases for one server — a proxy jump from outside, a LAN address from
 * inside, a VPN address — and each would otherwise list the same sessions
 * again and poll the same machine again.
 */
const MACHINE_ID = `ID=$(cat /etc/machine-id 2>/dev/null)
[ -z "$ID" ] && ID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
[ -z "$ID" ] && ID=$(hostname)
echo "$ID"`;

export interface TmuxSession {
  name: string;
  /** Epoch seconds. */
  created: number;
  attached: boolean;
  windows: number;
}

/**
 * The tmux sessions on a machine, whoever started them. Pods appear here too
 * (they are just named `omniagent-*`), so the list doubles as a way back into
 * work the app itself left running.
 */
export function listTmuxSessions(
  host: string | null,
): Promise<{ machine: string; sessions: TmuxSession[] }> {
  // Both answers in one round trip; the machine id comes first.
  //
  // `-u` is not optional. tmux sanitizes what it prints for a client it does
  // not consider UTF-8, and a GUI launch carries no LANG, so every tab below
  // came back as `_` — the sidebar then showed one field, "pod-1_1788503692_1_1",
  // and killing that name found nothing to kill.
  if (noLocalTmux(host)) return Promise.resolve({ machine: hostname(), sessions: [] });
  const query = `${MACHINE_ID}
tmux -u ls -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}' 2>/dev/null`;
  const [file, args] = shellArgv(host, query);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH: toolPath } },
      (_err, stdout) => {
        const [machine = "", ...lines] = stdout.split("\n");
        resolve({
          machine: machine.trim(),
          sessions: lines.filter(Boolean).map((line) => {
            const [name, created, attached, windows] = line.split("\t");
            return {
              name,
              created: Number.parseInt(created, 10) || 0,
              attached: attached === "1",
              windows: Number.parseInt(windows, 10) || 1,
            };
          }),
        });
      },
    );
  });
}

const instances = new Map<string, Instance>();

/**
 * Monotonic generation per spawn. A pod id can be re-spawned (e.g. a webview
 * reload); events from a superseded instance must not reach the new one.
 */
const generations = new Map<string, number>();
let nextGeneration = 1;

/**
 * A UTF-8 locale, keeping the user's when it already is one. A tmux client
 * without a UTF-8 LC_CTYPE treats the terminal as non-UTF-8 — dropping
 * multibyte (e.g. Korean) input and rendering wide glyphs as underscores.
 */
const lang = /utf-?8/i.test(process.env.LANG ?? "")
  ? (process.env.LANG as string)
  : "en_US.UTF-8";

const quote = (s: string) => s.replace(/'/g, "");

/**
 * The pod's window list, published as the terminal title.
 *
 * tmux rewrites the title whenever the window set or the active window changes,
 * so the pod header tracks `Ctrl+B c` / `Ctrl+B <n>` with no polling at all.
 * That is what makes this affordable for REMOTE pods: a `tmux list-windows`
 * poll would mean a fresh `ssh` every few seconds per pod, while the title
 * rides the pty stream that is already open.
 *
 * `#{W:<inactive>,<active>}` loops the session's windows, emitting the second
 * form for the current one — so the active window arrives marked with `*`
 * rather than having to be looked up separately. Names are cut to 12 chars and
 * stripped of the `|` record separator; the class in `s/[|]/ /` is deliberate,
 * since a bare `|` there reads as regex alternation and matches nothing.
 *
 * The `oa:` sentinel matters: without tmux (the fallback path below) the shell
 * and full-screen apps set titles of their own, and those must not be parsed
 * as windows.
 */
const TITLE_FORMAT =
  "oa:#{W:#{window_index}:#{=12:#{s/[|]/ /:window_name}}|," +
  "#{window_index}*:#{=12:#{s/[|]/ /:window_name}}|}";

/**
 * Attach-or-create the pod's own tmux session.
 *
 * Each pod gets its OWN named session — opening a host twice must create two
 * independent sessions, never mirror one. `-e` pins the locale on the session
 * itself: without it the shell inherits whatever environment the tmux *server*
 * was started with, and a server left over from a non-UTF-8 launch breaks
 * multibyte input while the rest of the app looks fine. `status off` hides
 * tmux's own bar (the pod header shows connection state, and now the windows
 * too), `mouse on` makes the wheel scroll tmux's scrollback instead of shell
 * history, and the clipboard options let tmux copies reach the system
 * clipboard over OSC 52.
 *
 * Every option after `new-session` lands on THIS session only — no `-g` — so a
 * pod cannot change how the user's own tmux sessions on the same server look.
 */
function tmuxCommand(session: string, locale: string): string {
  const name = quote(session);
  return (
    // `escape-time 0`: tmux otherwise sits on an ESC for half a second before
    // forwarding it, which outruns zsh's 0.4s KEYTIMEOUT — so ⌥⌫ arrives as a
    // bare Escape followed by a Backspace and only one character is deleted.
    // Full-screen apps parse the pair themselves and were unaffected, which is
    // why this looked like a shell-only bug.
    `tmux -u set-option -sg escape-time 0 \\; ` +
    `set-option -sq set-clipboard on \\; ` +
    `set-option -saq terminal-features 'xterm-256color:clipboard:RGB' \\; ` +
    `set-environment -g LANG ${locale} \\; ` +
    `set-environment -g LC_CTYPE ${locale} \\; ` +
    `new-session -A -s '${name}' -e LANG=${locale} -e LC_CTYPE=${locale} \\; ` +
    `set-option status off \\; set-option mouse on \\; ` +
    `set-option set-titles on \\; ` +
    `set-option set-titles-string '${TITLE_FORMAT}'`
  );
}

/**
 * tmux 3.0 and older do not understand `terminal-features` or `new-session -e`.
 * Keep the session usable when the modern command is rejected: in particular,
 * mouse mode must still be enabled or xterm translates the wheel into cursor
 * keys and the shell walks through command history instead of scrolling.
 */
function legacyTmuxCommand(session: string): string {
  const name = quote(session);
  return (
    `tmux -u new-session -A -s '${name}' \\; ` +
    `set-option status off \\; set-option mouse on \\; ` +
    `set-option set-titles on \\; ` +
    `set-option set-titles-string '${TITLE_FORMAT}'`
  );
}

export function spawnPty(
  sender: WebContents,
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
  ownsSession = true,
): void {
  // Supersede any existing instance for this pod id.
  const existing = instances.get(id);
  if (existing) {
    existing.proc.kill();
    instances.delete(id);
  }
  const generation = nextGeneration++;
  generations.set(id, generation);

  // A guest attaches and nothing more. `new-session -A` would recreate the
  // session the moment it was gone — so a guest pod left in the layout kept
  // resurrecting a session the user had just killed, with an empty shell in
  // it. Attach only, and exit when there is nothing to attach to; the pod
  // then closes and drops out of the layout on its own.
  const attachOnly = (name: string) =>
    `tmux -u attach-session -t '=${quote(name)}' || ` +
    `{ echo 'tmux session ${quote(name)} is gone'; exit 1; }`;

  /**
   * What a POSIX login shell somewhere else runs to become this pod.
   *
   * Used for ssh pods, and on Windows for local ones too — there the local
   * machine is a WSL distro, which is "somewhere else" in every way that
   * matters here: the app cannot read its `$SHELL`, so the command has to ask
   * for it on the far side, exactly as the remote case already did.
   */
  const elsewhere = (locale: string) =>
    !session
      ? "exec $SHELL -l"
      : !ownsSession
        ? attachOnly(session)
        : `${tmuxCommand(session, locale)} 2>/dev/null || ` +
          `${legacyTmuxCommand(session)} 2>/dev/null || exec $SHELL -l`;

  let file: string;
  let args: string[];
  if (host) {
    [file, args] = sshArgv(["-t", host, elsewhere("en_US.UTF-8")]);
  } else if (localIsNativeWindows()) {
    // A Windows without WSL: the pod is PowerShell under ConPTY, and that is
    // all it is. No tmux means no session to attach or restore — the pod comes
    // back empty on the next launch, the same as the no-tmux fallback a Mac
    // takes when tmux is not installed. A guest pod, opened onto a session
    // from the list, has nothing to attach to here (the list is empty for this
    // machine), so it says so and exits the way `attachOnly` does elsewhere,
    // rather than silently becoming a fresh shell.
    file = windowsShell;
    args =
      session && !ownsSession
        ? [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            `Write-Host 'tmux session ${quote(session)} is gone'; exit 1`,
          ]
        : ["-NoLogo"];
  } else if (localIsWsl()) {
    // A local pod on Windows is a WSL pod: the same command an ssh pod sends
    // to a server, carried by wsl.exe instead. `sh -l` only launches it —
    // tmux starts the user's real shell from /etc/passwd inside the session,
    // and that is the shell the pod actually feels like.
    //
    // TERM and the locale are exported by the command rather than handed to
    // node-pty below, because a Windows environment variable does not cross
    // into the distro: WSL forwards only what WSLENV names it, and a pod that
    // silently lost its locale is the exact failure this file spends most of
    // its comments on. The `cd` is there for the same reason — wsl.exe starts
    // in the translation of the Windows working directory, which is
    // `/mnt/c/Users/...` and nobody's home.
    //
    // The locale is chosen INSIDE the distro, and this is the one place that
    // must not do what the ssh branch does. `en_US.UTF-8` is a fair bet on a
    // server; on a WSL distro it is usually absent — a stock Ubuntu generates
    // only `C`, `C.utf8` and `POSIX`. Naming a locale that was never generated
    // does not fall back quietly: glibc drops to `C` collation while the
    // variables still claim UTF-8, and a zsh config doing anything with
    // character ranges dies with "character not in range", taking the user's
    // prompt down to the `%m%#` fallback — a shell with no path in it. So keep
    // whatever UTF-8 locale the distro already has, and only impose one when
    // it has none. `$LANG` reaches tmux as a shell expansion, which is why the
    // locale is passed down quoted.
    [file, args] = onLocalMachine("sh", [
      "-lc",
      `cd "$HOME" 2>/dev/null; ` +
        `case "\${LANG:-}" in *[Uu][Tt][Ff]*) ;; *) LANG=C.UTF-8 ;; esac; ` +
        `export TERM=xterm-256color COLORTERM=truecolor LANG LC_CTYPE="$LANG"; ` +
        elsewhere('"$LANG"'),
    ]);
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = !session
      ? ["-l"]
      : !ownsSession
        ? ["-l", "-c", attachOnly(session)]
        : [
            "-l",
            "-c",
            `command -v tmux >/dev/null 2>&1 && ` +
              `{ ${tmuxCommand(session, lang)} 2>/dev/null || ${legacyTmuxCommand(session)}; } ` +
              `|| exec "${file}" -l`,
          ];
  }

  // A pod is an interactive terminal and must look like one, whatever launched
  // the app. Started from a tool runner, the app inherits NO_COLOR=1,
  // FORCE_COLOR=0 and TERM=dumb — meant to keep captured output plain — and
  // every pod would then hand those to its shell, so the agents inside ran
  // monochrome. Remote pods escaped it only because ssh builds the environment
  // fresh on the server. Mirror image of the locale problem: there the app
  // inherited too little, here too much.
  const env = { ...process.env } as Record<string, string>;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;

  // A POSIX locale means nothing to PowerShell, and a stray LANG confuses the
  // odd Windows tool that does look; the native pod gets the terminal
  // variables only.
  const locale = IS_WINDOWS && !host ? {} : { LANG: lang, LC_CTYPE: lang };

  let proc: pty.IPty;
  try {
    proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: homedir(),
      env: {
        ...env,
        TERM: "xterm-256color",
        // xterm.js renders 24-bit colour; saying so is the truth, and tmux needs
        // to hear it too (see RGB in the terminal-features below).
        COLORTERM: "truecolor",
        ...locale,
      },
    });
  } catch (e) {
    // `pty_spawn` is fire-and-forget from the renderer, so a throw here has no
    // promise to land in — it would surface as Electron's "JavaScript error in
    // the main process" dialog, with a pod left blank behind it. Tell the pod
    // instead, in the terminal it is already showing, and let it end the way
    // a client that died on its own does.
    if (sender.isDestroyed()) return;
    const reason = e instanceof Error ? e.message : String(e);
    sender.send("pty-output", {
      id,
      data: `\r\n\x1b[31m[OmniAgent] could not start ${file}: ${reason}\x1b[0m\r\n`,
    });
    sender.send("pty-exit", { id });
    return;
  }

  const isCurrent = () => generations.get(id) === generation;
  proc.onData((data) => {
    // Drop output the moment this instance is superseded, so a stale client
    // can't double-render into the pod.
    if (!isCurrent() || sender.isDestroyed()) return;
    sender.send("pty-output", { id, data });
  });
  proc.onExit(() => {
    // Superseded instances stop here: the map already holds their successor,
    // and clearing its session would disarm the wrong pod.
    if (!isCurrent()) return;
    // The client died on its own — a dropped ssh connection, a killed tmux
    // client, a `exit` typed into the shell. Whichever it was, this instance
    // has no claim on the tmux session any more: the session outlives the
    // connection, and the pod close that may follow must not be able to reach
    // the kill-session branch below. Only a still-live client counts as an
    // explicit close.
    const inst = instances.get(id);
    if (inst) inst.session = null;
    if (sender.isDestroyed()) return;
    sender.send("pty-exit", { id });
  });

  instances.set(id, { proc, host, session, ownsSession });
}

export function writePty(id: string, data: string): void {
  instances.get(id)?.proc.write(data);
}

export function resizePty(id: string, rows: number, cols: number): void {
  try {
    instances.get(id)?.proc.resize(cols, rows);
  } catch {
    // The pod may have exited between the resize observer and this call.
  }
}

/**
 * Rename a session, so naming a pod carries through to `tmux ls` and to the
 * sessions panel. Fails harmlessly when the name is taken.
 */
export function renameTmuxSession(
  host: string | null,
  from: string,
  to: string,
): Promise<boolean> {
  if (noLocalTmux(host)) return Promise.resolve(false);
  const command = `tmux rename-session -t '${quote(from)}' '${quote(to)}'`;
  const [file, args] = shellArgv(host, command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH: toolPath } },
      (err) => resolve(!err),
    );
  });
}

/** End a session from the sessions list, whoever started it. */
export function killTmuxSession(host: string | null, name: string): Promise<void> {
  if (noLocalTmux(host)) return Promise.resolve();
  const command = `tmux kill-session -t '${quote(name)}'`;
  const [file, args] = shellArgv(host, command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH: toolPath } },
      () => resolve(),
    );
  });
}

/**
 * Switch the session to one of its windows — what clicking a window in the pod
 * header does.
 *
 * Deliberately NOT typed into the pty as `<prefix> <n>`. That looks simpler and
 * works for single digits, but tmux only binds the digit keys 0-9, and driving
 * its command prompt instead (`<prefix> : select-window …`) turns out not to
 * work at all through a pty write. Walking there with `next-window` does work,
 * but only when the keystrokes are spaced out — sent as one burst tmux acts on
 * just the first. Asking the server directly sidesteps all of it, and works the
 * same for a guest pod whose owner rebound the prefix.
 */
export function selectTmuxWindow(
  host: string | null,
  session: string,
  index: number,
): Promise<void> {
  if (noLocalTmux(host)) return Promise.resolve();
  const command = `tmux select-window -t '${quote(session)}:${Math.trunc(index)}'`;
  const [file, args] = shellArgv(host, command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH: toolPath } },
      () => resolve(),
    );
  });
}

/**
 * Explicit close: tear down the pod's backing tmux session too, so sessions
 * don't pile up. Detached so a slow ssh round-trip never blocks closing.
 *
 * "Explicit" means a client that was still alive when the pod closed. One that
 * had already exited cleared its session on the way out (see `onExit`), so a
 * dropped connection — and the pod teardown that follows it — leaves the work
 * on the server running.
 */
export function killPty(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  instances.delete(id);
  generations.delete(id);
  inst.proc.kill();

  if (!inst.session || !inst.ownsSession || noLocalTmux(inst.host)) return;
  const name = quote(inst.session);
  // Only the local `tmux` needs the Homebrew prefixes a GUI launch did not
  // inherit; `ssh` is on the system PATH wherever this runs.
  const [file, args] = inst.host
    ? sshArgv([...SSH_ONESHOT, inst.host, `tmux kill-session -t '${name}'`])
    : onLocalMachine("tmux", ["kill-session", "-t", name]);
  const options = inst.host ? {} : { env: { ...process.env, PATH: toolPath } };
  spawn(file, args, options).unref();
}

/**
 * Detach a pod — the ⌘/Ctrl+W close. Tears down the client exactly as
 * `killPty` does (drop the generation first so its `onExit` stays silent, then
 * kill the process), but never touches the tmux session: the work keeps
 * running, and the pod reattaches to it on the next launch. The panel teardown
 * that follows calls `killPty`, which finds nothing left and no-ops — so this
 * must run first, which the caller guarantees.
 */
export function detachPty(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  instances.delete(id);
  generations.delete(id);
  inst.proc.kill();
}

/**
 * Kill every pty on the way out — but leave the tmux sessions alone. They are
 * exactly what the next launch restores.
 */
export function killAllPtys(): void {
  for (const [, inst] of instances) inst.proc.kill();
  instances.clear();
  generations.clear();
}

/**
 * When the pod's tmux session was created (epoch seconds). That, not the
 * moment the pod was opened, is how long the work has been running — the
 * session outlives app restarts.
 */
export function tmuxSessionStarted(
  host: string | null,
  session: string,
): Promise<number | null> {
  if (noLocalTmux(host)) return Promise.resolve(null);
  const query = `tmux display -p -t '${quote(session)}' '#{session_created}' 2>/dev/null`;
  const [file, args] = shellArgv(host, query);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH: toolPath } },
      (_err, stdout) => {
        const seconds = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(seconds) ? seconds : null);
      },
    );
  });
}
