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
   * the pod can restore.
   */
  session: string | null;
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
 * Attach-or-create the pod's own tmux session.
 *
 * Each pod gets its OWN named session — opening a host twice must create two
 * independent sessions, never mirror one. `-e` pins the locale on the session
 * itself: without it the shell inherits whatever environment the tmux *server*
 * was started with, and a server left over from a non-UTF-8 launch breaks
 * multibyte input while the rest of the app looks fine. `status off` hides
 * tmux's own bar (the pod header already shows connection state), `mouse on`
 * makes the wheel scroll tmux's scrollback instead of shell history, and the
 * clipboard options let tmux copies reach the system clipboard over OSC 52.
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
    `set-option status off \\; set-option mouse on`
  );
}

export function spawnPty(
  sender: WebContents,
  id: string,
  host: string | null,
  session: string | null,
  rows: number,
  cols: number,
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
    if (!isCurrent() || sender.isDestroyed()) return;
    sender.send("pty-exit", { id });
  });

  instances.set(id, { proc, host, session });
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
 * Explicit close: tear down the pod's backing tmux session too, so sessions
 * don't pile up. Detached so a slow ssh round-trip never blocks closing.
 */
export function killPty(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  instances.delete(id);
  generations.delete(id);
  inst.proc.kill();

  if (!inst.session) return;
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
