import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import * as pty from "node-pty";
import type { WebContents } from "electron";

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
  const query = `${MACHINE_ID}
tmux ls -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}' 2>/dev/null`;
  const [file, args] = host
    ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, query]] as const)
    : (["sh", ["-c", query]] as const);
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
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

/** PATH for helper commands — a GUI launch inherits almost nothing. */
const toolPath = `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;

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
    `set-option -saq terminal-features 'xterm-256color:clipboard' \\; ` +
    `set-environment -g LANG ${locale} \\; ` +
    `set-environment -g LC_CTYPE ${locale} \\; ` +
    `new-session -A -s '${name}' -e LANG=${locale} -e LC_CTYPE=${locale} \\; ` +
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

  let file: string;
  let args: string[];
  if (host) {
    const remote = session
      ? `${tmuxCommand(session, "en_US.UTF-8")} 2>/dev/null || ` +
        `tmux -u new-session -A -s '${quote(session)}' 2>/dev/null || exec $SHELL -l`
      : "exec $SHELL -l";
    file = "ssh";
    args = ["-t", host, remote];
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = session
      ? [
          "-l",
          "-c",
          `command -v tmux >/dev/null 2>&1 && exec ${tmuxCommand(session, lang)} || exec "${file}" -l`,
        ]
      : ["-l"];
  }

  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LANG: lang,
      LC_CTYPE: lang,
    } as Record<string, string>,
  });

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
  const command = `tmux rename-session -t '${quote(from)}' '${quote(to)}'`;
  const [file, args] = host
    ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command]] as const)
    : (["sh", ["-c", command]] as const);
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      { env: { ...process.env, PATH: toolPath } },
      (err) => resolve(!err),
    );
  });
}

/** End a session from the sessions list, whoever started it. */
export function killTmuxSession(host: string | null, name: string): Promise<void> {
  const command = `tmux kill-session -t '${quote(name)}'`;
  const [file, args] = host
    ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command]] as const)
    : (["sh", ["-c", command]] as const);
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
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
  const command = `tmux select-window -t '${quote(session)}:${Math.trunc(index)}'`;
  const [file, args] = host
    ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command]] as const)
    : (["sh", ["-c", command]] as const);
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
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

  if (!inst.session || !inst.ownsSession) return;
  const name = quote(inst.session);
  if (inst.host) {
    spawn("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      inst.host,
      `tmux kill-session -t '${name}'`,
    ]).unref();
  } else {
    spawn("tmux", ["kill-session", "-t", name], {
      env: { ...process.env, PATH: toolPath },
    }).unref();
  }
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
  const query = `tmux display -p -t '${quote(session)}' '#{session_created}' 2>/dev/null`;
  const [file, args] = host
    ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, query]] as const)
    : (["sh", ["-c", query]] as const);
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      { env: { ...process.env, PATH: toolPath } },
      (_err, stdout) => {
        const seconds = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(seconds) ? seconds : null);
      },
    );
  });
}
