import {
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { ILink, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  BrowserClipboardProvider,
  ClipboardAddon,
} from "@xterm/addon-clipboard";
import {
  fsHomeDir,
  fsStat,
  tmuxRenameSession,
  tmuxSessionStarted,
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../ipc";
import { HostStats, subscribeHostStats } from "../hostStats";
import { useSettings } from "../settings";
import { setupImeInput } from "../ime";
import { Explorer } from "./Explorer";
import { EditorPanel } from "./EditorPanel";

/**
 * tmux emits its copies as `OSC 52 ; ; <base64>` — an EMPTY selection field —
 * which the default provider silently ignores (it only honors "c"). Treat
 * empty as the system clipboard.
 */
class TmuxFriendlyClipboardProvider extends BrowserClipboardProvider {
  public override writeText(selection: never, text: string): Promise<void> {
    const sel = ((selection as string) === "" ? "c" : selection) as never;
    return super.writeText(sel, text);
  }
  public override readText(selection: never): Promise<string> {
    const sel = ((selection as string) === "" ? "c" : selection) as never;
    return super.readText(sel);
  }
}

export type PodStatus = "connecting" | "running" | "exited";
export type PodActivity = "working" | "idle" | "attention";

/** How long output must stay quiet before a working pod counts as idle. */
const IDLE_AFTER_MS = 4000;

/** Prompts that mean the agent is waiting on the human. */
const ATTENTION_RE =
  /(\[y\/n\]|\(y\/n\)|\[y\/N\]|do you want|proceed\?|continue\?|are you sure|press enter|password:|passphrase|permission|허용|계속할까요|진행할까요|1\. yes)/i;

/** Strip OSC/CSI/charset escape sequences so patterns match visible text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "");
}

/**
 * Pod state shared between the panel (terminal body) and its tab (header).
 * Lives in dockview params so both sides see updates and it serializes with
 * the layout.
 */
export interface PodParams {
  host: string | null; // null = local shell
  label: string;
  status?: PodStatus;
  activity?: PodActivity;
  startedAt?: number;
  explorerOpen?: boolean;
  editorOpen?: boolean;
  /** Directory the explorer is browsing — restored with the layout. */
  explorerPath?: string;
  /** File open in the editor — restored with the layout. */
  editorPath?: string;
  /**
   * The tmux session behind this pod. Absent until something names it —
   * `omniagent-<pod id>` is the default.
   */
  session?: string;
  /**
   * True for a pod opened onto a session that was already running. A guest
   * leaves the session alone when it closes, and never renames it.
   */
  guest?: boolean;
  /** What the user called this pod, if anything. */
  name?: string;
  /** Pane sizes, dragged by the splitters. */
  explorerWidth?: number;
  editorHeight?: number;
}

/**
 * The bar between two panes. Dragging it resizes the one before it; the
 * terminal refits on its own, since it is watching its container.
 */
function Splitter({
  axis,
  onDrag,
  onDone,
}: {
  axis: "x" | "y";
  onDrag: (delta: number) => void;
  onDone: () => void;
}) {
  const last = useRef(0);
  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = axis === "x" ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const now = axis === "x" ? e.clientX : e.clientY;
        onDrag(now - last.current);
        last.current = now;
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onDone();
      }}
      className={`shrink-0 bg-surface-container-highest hover:bg-primary/50 transition-colors ${
        axis === "x" ? "w-px hover:w-1 cursor-col-resize" : "h-px hover:h-1 cursor-row-resize"
      }`}
    />
  );
}


/**
 * Path-ish tokens in terminal output: absolute (/etc/hosts, ~/src), explicitly
 * relative (./x, ../x), nested relative (src/app.ts) and bare filenames with a
 * known extension. Trailing punctuation and :line:col suffixes are trimmed by
 * the caller.
 */
const PATH_RE =
  /(?:~|\.{1,2})?\/[\w.\-/@+]+|\b[\w.\-]+\/[\w.\-/@+]+|\b[\w.\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|toml|ya?ml|md|txt|log|css|scss|html|py|rs|go|java|kt|swift|c|h|cpp|hpp|sh|zsh|sql|env|lock|pdf)\b/g;

/** Strip decoration the shell or an agent tends to put around a path. */
function cleanPath(raw: string): string {
  let p = raw.replace(/^[('"`\[]+/, "").replace(/[)'"`\],.;:]+$/, "");
  // file.ts:12:3 / file.ts:12 → file.ts
  p = p.replace(/:(\d+)(:\d+)?$/, "");
  return p;
}

/** The bits of xterm's internals the pod reaches into. */
interface PodCore {
  _selectionService?: { shouldForceSelection: (e: MouseEvent) => boolean };
}

const TERM_THEME = {
  background: "#0e0e0e",
  foreground: "#e5e2e1",
  cursor: "#e5e2e1",
  selectionBackground: "#569cd640",
  black: "#131313",
  brightBlack: "#8a919a",
  blue: "#569cd6",
  brightBlue: "#95ccff",
  green: "#61dac1",
  brightGreen: "#80f7dc",
  yellow: "#c9c999",
  brightYellow: "#e6e5b3",
  red: "#ffb4ab",
  brightRed: "#ffdad6",
};

/**
 * The pod header, rendered as the dockview TAB — so grabbing anywhere on the
 * header drags the pod, with dockview's translucent drop preview showing
 * where it will land (top/bottom/left/right split or stack).
 */
/** Thin CPU/RAM bars for the pod's machine. */
function Meters({ stats }: { stats: HostStats | null }) {
  if (!stats || !stats.mem_total_mb) return null;
  const memPct = (stats.mem_used_mb / stats.mem_total_mb) * 100;
  const bar = (pct: number, tone: string) => (
    <span className="w-6 h-1 rounded-full bg-surface-container-highest overflow-hidden">
      <span
        className={`block h-full ${tone}`}
        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
      />
    </span>
  );
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  return (
    <span
      className="hidden sm:flex items-center gap-1.5 text-[10px] text-outline"
      title={`CPU ${stats.cpu.toFixed(0)}% · RAM ${gb(stats.mem_used_mb)}/${gb(
        stats.mem_total_mb,
      )} GB`}
    >
      {bar(stats.cpu, stats.cpu > 85 ? "bg-error" : "bg-secondary")}
      {bar(memPct, memPct > 90 ? "bg-error" : "bg-primary-container")}
    </span>
  );
}

export function PodTab(props: IDockviewPanelHeaderProps<PodParams>) {
  const {
    label,
    name,
    status = "connecting",
    activity = "idle",
    startedAt,
    explorerOpen,
    editorOpen,
  } = props.params;
  const [renaming, setRenaming] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [stats, setStats] = useState<HostStats | null>(null);
  const [, tick] = useState(0);

  const settings = useSettings();
  useEffect(() => {
    if (!settings.meters) {
      setStats(null);
      return;
    }
    return subscribeHostStats(props.params.host, setStats);
  }, [props.params.host, settings.meters]);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const sub = props.containerApi.onDidMaximizedGroupChange(() =>
      setMaximized(props.api.isMaximized()),
    );
    return () => sub.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dotClass =
    status === "exited"
      ? "bg-error"
      : status === "connecting"
        ? "bg-tertiary animate-pulse"
        : activity === "attention"
          ? "bg-[#ffb960] shadow-[0_0_10px_rgba(255,185,96,0.7)] animate-pulse"
          : activity === "working"
            ? "bg-secondary shadow-[0_0_8px_rgba(97,218,193,0.4)]"
            : "bg-outline";

  // Keep button clicks from starting a tab drag.
  const guard = (e: React.MouseEvent) => e.stopPropagation();

  /**
   * Naming a pod names its tmux session too, so the name shows up in the
   * sessions panel and in a plain `tmux ls` — the pod is a view onto the
   * session, and `pod-4` says nothing about what is running in it. Sessions
   * the pod is only visiting keep their own name.
   */
  const rename = async (value: string) => {
    setRenaming(false);
    const label = value.trim();
    if (label === (name ?? "")) return;
    props.api.updateParameters({ name: label || undefined });

    const { host, session, guest } = props.params;
    if (guest) return;
    const slug = label.toLowerCase().replace(/\s+/g, "-").replace(/[^\w.-]/g, "");
    const from = session ?? `omniagent-${props.api.id}`;
    const to = slug ? `omniagent-${slug}` : `omniagent-${props.api.id}`;
    if (to === from) return;
    if (await tmuxRenameSession(host, from, to).catch(() => false)) {
      props.api.updateParameters({ session: to });
    }
  };

  const iconClass = (active: boolean | undefined) =>
    `material-symbols-outlined text-[16px] cursor-pointer ${
      active ? "text-primary" : "text-on-surface-variant hover:text-on-surface"
    }`;

  return (
    <div className="flex items-center justify-between gap-4 h-full w-full px-3 cursor-grab active:cursor-grabbing select-none">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
        {renaming ? (
          <input
            autoFocus
            defaultValue={name ?? ""}
            placeholder={label}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") rename(e.currentTarget.value);
              if (e.key === "Escape") setRenaming(false);
            }}
            className="text-[11px] font-medium bg-surface-container-high text-on-surface rounded px-1 py-0.5 w-32 outline-none border border-primary"
          />
        ) : (
          <span
            className="text-[11px] font-medium text-on-surface uppercase tracking-wider truncate"
            title="Double-click to name this pod"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
            }}
          >
            {name || label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {status === "running" && activity === "attention" && (
          <span className="text-[10px] font-semibold tracking-wider text-[#ffb960] bg-[#ffb960]/15 px-1.5 py-0.5 rounded animate-pulse">
            NEEDS INPUT
          </span>
        )}
        {status === "running" && <Meters stats={stats} />}
        <span className="font-mono text-on-surface-variant text-[11px]">
          {status === "exited"
            ? "ENDED"
            : startedAt
              ? `UP ${formatUptime(Date.now() - startedAt)}`
              : "…"}
        </span>
        <span
          className={iconClass(explorerOpen)}
          title="Toggle explorer"
          onMouseDown={guard}
          onClick={() =>
            props.api.updateParameters({ explorerOpen: !explorerOpen })
          }
        >
          folder_open
        </span>
        <span
          className={iconClass(editorOpen)}
          title="Toggle editor"
          onMouseDown={guard}
          onClick={() =>
            props.api.updateParameters({ editorOpen: !editorOpen })
          }
        >
          description
        </span>
        <span
          className={iconClass(maximized)}
          title={maximized ? "Restore pod" : "Maximize pod"}
          onMouseDown={guard}
          onClick={() => {
            if (props.api.isMaximized()) {
              props.api.exitMaximized();
              setMaximized(false);
            } else {
              props.api.maximize();
              setMaximized(true);
            }
          }}
        >
          {maximized ? "fullscreen_exit" : "fullscreen"}
        </span>
        <span
          className="material-symbols-outlined text-[16px] cursor-pointer text-on-surface-variant hover:text-error"
          title="Close pod (kills its session)"
          onMouseDown={guard}
          onClick={() => props.api.close()}
        >
          close
        </span>
      </div>
    </div>
  );
}

export function TerminalPod(props: IDockviewPanelProps<PodParams>) {
  const { host, explorerOpen, editorOpen } = props.params;
  const podId = props.api.id;
  const containerRef = useRef<HTMLDivElement>(null);
  const editorPath = props.params.editorPath ?? null;
  const setEditorPath = (path: string | null) =>
    props.api.updateParameters({ editorPath: path ?? undefined });
  const [explorerWidth, setExplorerWidth] = useState(
    props.params.explorerWidth ?? 200,
  );
  const [editorHeight, setEditorHeight] = useState(
    props.params.editorHeight ?? 320,
  );
  const [explorerGoto, setExplorerGoto] = useState<{
    path: string;
    nonce: number;
  } | null>(null);
  const explorerCwdRef = useRef<string | null>(null);
  const homeRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // OSC 52 → system clipboard, so tmux copy-mode / mouse-drag copies
    // (set-clipboard on) actually land in the macOS clipboard (#13).
    term.loadAddon(
      new ClipboardAddon(undefined, new TmuxFriendlyClipboardProvider()),
    );
    // xterm measures the cell grid the moment it opens, and the terminal
    // font is fetched over the network — so a pod that opens first is sized
    // against the fallback font and never re-measured, leaving the rendered
    // text and the mouse-to-cell mapping on slightly different grids.
    const fontLoaded = document.fonts.check('13px "JetBrains Mono"');
    term.open(el);

    // tmux has to own the mouse for the wheel to scroll its scrollback, but
    // that also hands it drag-selection — and tmux copies and clears the
    // highlight the instant the drag ends, so a selection can never be looked
    // at, adjusted, or extended. Take left-button drags back for the browser:
    // xterm skips reporting them and selects natively instead (the selection
    // stays until you click away, ⌘C copies it), while the wheel and every
    // other button still report to tmux.
    const selection = (term as unknown as { _core?: PodCore })._core
      ?._selectionService;
    if (selection) selection.shouldForceSelection = (e) => e.button === 0;

    let disposed = false;
    if (!fontLoaded) {
      document.fonts.ready.then(() => {
        if (disposed) return;
        // Round-trip the family so xterm re-measures with the real font.
        term.options.fontFamily = "monospace";
        term.options.fontFamily = "JetBrains Mono, monospace";
        fit.fit();
      });
    }
    const unlisteners: Array<() => void> = [];

    const spawnedAt = Date.now();

    // ---- Agent activity detection (#2): working / idle / needs-input ----
    let activity: PodActivity = "idle";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let plainTail = "";
    const setActivity = (a: PodActivity) => {
      if (a !== activity && !disposed) {
        activity = a;
        props.api.updateParameters({ activity: a });
      }
    };
    const trackActivity = (data: string) => {
      const plain = stripAnsi(data);
      const rangBell = plain.includes("\x07");
      plainTail = (plainTail + plain.replace(/\x07/g, "")).slice(-600);
      const visibleTail = plainTail.replace(/\s+/g, " ").trim().slice(-300);
      clearTimeout(idleTimer);
      if (rangBell || ATTENTION_RE.test(visibleTail)) {
        setActivity("attention");
      } else {
        setActivity("working");
        idleTimer = setTimeout(() => {
          if (activity === "working") setActivity("idle");
        }, IDLE_AFTER_MS);
      }
    };
    // The human responding releases the attention state (and clears the
    // tail so the old prompt text can't re-trigger it).
    const onUserInput = () => {
      if (activity === "attention") {
        plainTail = "";
        setActivity("working");
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (activity === "working") setActivity("idle");
        }, IDLE_AFTER_MS);
      }
    };

    // Fit after first layout, then spawn the PTY at the fitted size.
    requestAnimationFrame(async () => {
      if (disposed) return;
      fit.fit();
      try {
        // Every pod runs inside its OWN named tmux session (stable per pod
        // id), local or remote — so opening the same server twice gives two
        // independent sessions, and each pod restores its own content when
        // the app is reopened.
        const session = props.params.session ?? `omniagent-${podId}`;
        await ptySpawn(podId, host, session, term.rows, term.cols, !props.params.guest);
        if (!disposed) {
          props.api.updateParameters({ status: "running" });
          // Uptime counts the tmux session's life, which survives app
          // restarts — not when this pod happened to be opened.
          tmuxSessionStarted(host, session)
            .then((epoch) => {
              if (!disposed) {
                props.api.updateParameters({
                  startedAt: epoch ? epoch * 1000 : Date.now(),
                });
              }
            })
            .catch(() => {
              if (!disposed) props.api.updateParameters({ startedAt: Date.now() });
            });
        }
      } catch (e) {
        term.writeln(`\x1b[31m[OmniAgent] spawn failed: ${e}\x1b[0m`);
        props.api.updateParameters({ status: "exited" });
        return;
      }

      unlisteners.push(
        await onPtyOutput(({ id, data }) => {
          if (id !== podId) return;
          term.write(data);
          trackActivity(data);
        }),
      );
      unlisteners.push(
        await onPtyExit(({ id }) => {
          if (id !== podId) return;
          // Auto-close the pod when the session ends (`exit`, ssh disconnect).
          // Sessions that die within 5s likely failed to connect — keep those
          // open so the error output stays readable.
          if (Date.now() - spawnedAt > 5000) {
            props.api.close();
          } else {
            props.api.updateParameters({ status: "exited" });
            term.writeln("\r\n\x1b[90m[OmniAgent] session ended\x1b[0m");
          }
        }),
      );
    });

    // Serialize ALL pty writes through one promise chain: xterm's own
    // emissions and the IME bridge's are separate async invokes, and
    // out-of-order delivery (e.g. a Tab overtaking a flushed syllable)
    // corrupts the shell's input state.
    let writeChain: Promise<unknown> = Promise.resolve();
    const write = (data: string) => {
      if (!data) return;
      onUserInput();
      writeChain = writeChain.then(() =>
        ptyWrite(podId, data).catch(() => {}),
      );
    };

    // Under WKWebView the IME reports composed text in a way xterm ignores;
    // the bridge fills that in and stands down where composition events fire,
    // which is every Chromium build. See WEBKIT-IME.md.
    const ime = setupImeInput(term, write);
    const dataSub = term.onData((data) => {
      const out = ime.route(data);
      if (out) write(out);
    });

    // ⌘/Ctrl-click a path in the output: directories open the explorer,
    // files open in the editor. Paths are only decorated while the modifier
    // is held, so normal output stays clean.
    let modifierHeld = false;
    const onModKey = (e: KeyboardEvent) => {
      modifierHeld = e.metaKey || e.ctrlKey;
    };
    window.addEventListener("keydown", onModKey);
    window.addEventListener("keyup", onModKey);

    const resolvePath = async (raw: string): Promise<string | null> => {
      const p = cleanPath(raw);
      if (!p) return null;
      if (p.startsWith("/")) return p;
      if (p.startsWith("~")) {
        if (!homeRef.current) homeRef.current = await fsHomeDir(host);
        return p.replace(/^~/, homeRef.current);
      }
      // Relative paths resolve against the directory the explorer is showing;
      // with no explorer open there is nothing to resolve against.
      const base = explorerCwdRef.current;
      if (!base) return null;
      return `${base.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
    };

    const linkSub = term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        if (!modifierHeld) return callback(undefined);
        const line = term.buffer.active.getLine(lineNumber - 1);
        const text = line?.translateToString(true) ?? "";
        const links: ILink[] = [];
        for (const m of text.matchAll(PATH_RE)) {
          const raw = m[0];
          const start = m.index ?? 0;
          links.push({
            range: {
              start: { x: start + 1, y: lineNumber },
              end: { x: start + raw.length, y: lineNumber },
            },
            text: raw,
            activate: async () => {
              const full = await resolvePath(raw);
              if (!full) return;
              try {
                const info = await fsStat(host, full);
                if (!info.exists) return;
                if (info.is_dir) {
                  props.api.updateParameters({ explorerOpen: true });
                  setExplorerGoto({ path: full, nonce: Date.now() });
                } else {
                  setEditorPath(full);
                  props.api.updateParameters({ editorOpen: true });
                }
              } catch {
                /* unreachable path — leave the terminal alone */
              }
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || el.clientWidth === 0) return;
        fit.fit();
        ptyResize(podId, term.rows, term.cols).catch(() => {});
      }, 80);
    });
    observer.observe(el);

    const focusDispose = props.api.onDidActiveChange((e) => {
      if (e.isActive) term.focus();
    });
    term.focus();

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onModKey);
      window.removeEventListener("keyup", onModKey);
      linkSub.dispose();
      clearTimeout(idleTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
      ime.dispose();
      focusDispose.dispose();
      unlisteners.forEach((u) => u());
      ptyKill(podId).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podId, host]);

  return (
    <div className="flex flex-col h-full bg-surface-container-low">
      {/* Pod body: explorer | (editor above / terminal below — VS Code style) */}
      <div className="flex flex-1 min-h-0">
        {explorerOpen && (
          <>
          <Explorer
            width={explorerWidth}
            host={host}
            onOpenFile={(path) => {
              setEditorPath(path);
              props.api.updateParameters({ editorOpen: true });
            }}
            initialPath={props.params.explorerPath}
            onCwdChange={(cwd) => {
              explorerCwdRef.current = cwd;
              if (cwd !== props.params.explorerPath)
                props.api.updateParameters({ explorerPath: cwd });
            }}
            gotoPath={explorerGoto}
          />
          <Splitter
            axis="x"
            onDrag={(dx) =>
              setExplorerWidth((w) => Math.min(600, Math.max(120, w + dx)))
            }
            onDone={() =>
              props.api.updateParameters({ explorerWidth })
            }
          />
          </>
        )}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {editorOpen && (
            <>
              <EditorPanel
                height={editorHeight}
                host={host}
                path={editorPath}
                onClose={() => props.api.updateParameters({ editorOpen: false })}
              />
              <Splitter
                axis="y"
                onDrag={(dy) =>
                  setEditorHeight((h) => Math.min(900, Math.max(80, h + dy)))
                }
                onDone={() => props.api.updateParameters({ editorHeight })}
              />
            </>
          )}
          <div className="flex-1 min-h-0 bg-surface-container-lowest p-1">
            <div ref={containerRef} className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  // Sessions live for days, so keep the label short once past 24h.
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

