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
  tmuxSelectWindow,
  tmuxSessions,
  tmuxSessionStarted,
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../ipc";
import { HostStats, subscribeHostStats } from "../hostStats";
import { activeFont, primaryFamily, useSettings } from "../settings";
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

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

/** The pod-close shortcut, spelled for whichever platform this build runs on. */
const CLOSE_SHORTCUT = IS_MAC ? "⌘W" : "Ctrl+W";

export type PodStatus = "connecting" | "running" | "exited";
export type PodActivity = "working" | "idle" | "attention";

/** One tmux window behind the pod, as the header lists it. */
export interface PodWindow {
  index: number;
  name: string;
  active: boolean;
}

/**
 * The window list tmux publishes as the terminal title — `oa:0:zsh|1*:vim|`,
 * built by TITLE_FORMAT in the pty backends. Returns null for every other
 * title: a pod running without tmux still gets titles from the shell and from
 * full-screen apps, and those are not windows.
 */
export function parseWindowTitle(title: string): PodWindow[] | null {
  if (!title.startsWith("oa:")) return null;
  const windows: PodWindow[] = [];
  for (const record of title.slice(3).split("|")) {
    // Name last and unanchored: tmux already stripped `|` from it, but it may
    // well contain the `:` that separates it from the index.
    const m = /^(\d+)(\*?):(.*)$/.exec(record);
    if (m) windows.push({ index: +m[1], name: m[3], active: m[2] === "*" });
  }
  return windows;
}

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
  /**
   * The pod lost its connection while the session kept running. Distinct from
   * a session that ended: the work is still there, and the pod can go back to
   * it. Shown on the tab so a small pod still says so.
   */
  dropped?: boolean;
  /** What the user called this pod, if anything. */
  name?: string;
  /**
   * The tmux windows in the pod's session, newest state tmux pushed. Only
   * meaningful while connected — the pod clears it on every (re)connect so a
   * restored layout never shows a list that predates the current session.
   */
  windows?: PodWindow[];
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
  /(?:~|\.{1,2})?\/[\w.\-/@+]+|\b[\w.\-]+\/[\w.\-/@+]+|\b[\w.\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|toml|ya?ml|md|txt|log|css|scss|html|py|rs|go|java|kt|swift|c|h|cpp|hpp|sh|zsh|sql|env|lock)\b/g;

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
    dropped,
    explorerOpen,
    editorOpen,
    windows = [],
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
      ? // A lost connection is recoverable and an ended session is not, so
        // they do not get to look the same.
        dropped
        ? "bg-[#ffb960]"
        : "bg-error"
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

  /**
   * Jump to a window. The server is asked directly rather than the keystroke
   * being typed into the pty — see `selectTmuxWindow` for why that route does
   * not survive double-digit indices. tmux pushes the new title straight after,
   * so the strip re-marks itself with no extra round trip.
   */
  const selectWindow = (index: number) => {
    // Same default the pod body attaches with: `session` is only stored once
    // something renames it, so most pods carry the id-derived name instead.
    const session = props.params.session ?? `omniagent-${props.api.id}`;
    tmuxSelectWindow(props.params.host, session, index).catch(() => {});
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
        {/*
          One window is just "the shell" — nothing to switch between — so the
          strip only earns its space once the session has more. Gated on
          `running` because a dropped client's last list is stale and its
          clicks would go nowhere.
        */}
        {status === "running" && windows.length > 1 && (
          <div className="flex items-center gap-1 min-w-0 overflow-hidden">
            {windows.map((w) => (
              <span
                key={w.index}
                // tmux binds the digit keys only, so past the tenth window
                // there is no shortcut to advertise — just the click.
                title={
                  w.index < 10
                    ? `${w.name} — Ctrl+B ${w.index}`
                    : `${w.name} — click to switch`
                }
                onMouseDown={guard}
                onClick={() => selectWindow(w.index)}
                className={`font-mono text-[10px] leading-none px-1.5 py-1 rounded cursor-pointer shrink-0 max-w-28 truncate ${
                  w.active
                    ? "bg-primary/15 text-primary"
                    : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
                }`}
              >
                {w.index} {w.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {status === "running" && activity === "attention" && (
          <span className="text-[10px] font-semibold tracking-wider text-[#ffb960] bg-[#ffb960]/15 px-1.5 py-0.5 rounded animate-pulse">
            NEEDS INPUT
          </span>
        )}
        {status === "running" && <Meters stats={stats} />}
        <span
          className={`font-mono text-[11px] ${
            dropped ? "text-[#ffb960]" : "text-on-surface-variant"
          }`}
        >
          {status === "exited"
            ? dropped
              ? "LOST"
              : "ENDED"
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
          title={
            dropped
              ? "Close pod (the session keeps running on the server)"
              : `Close pod (kills its session) — ${CLOSE_SHORTCUT} closes it but keeps the session running`
          }
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
  const settings = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  // Held so the font-change effect below can re-drive a live terminal without
  // tearing it down — the creation effect must not depend on the font.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
  /**
   * Set when the client died with its session still running — `alive` when the
   * server said so, `unreachable` when nothing answered. Null while connected.
   */
  const [dropped, setDropped] = useState<"alive" | "unreachable" | null>(null);
  /** Re-attaches this pod. Owned by the terminal effect, called by the banner. */
  const reconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Open with whatever font is active right now — a pod created while
    // D2Coding (or a custom family) is selected must start correct, not flip
    // to it a frame later. Live changes are handled by a separate effect.
    const initialMono = activeFont().mono;
    const term = new Terminal({
      fontFamily: initialMono,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    // OSC 52 → system clipboard, so tmux copy-mode / mouse-drag copies
    // (set-clipboard on) actually land in the macOS clipboard (#13).
    term.loadAddon(
      new ClipboardAddon(undefined, new TmuxFriendlyClipboardProvider()),
    );

    // The app owns a few modifier combos (handled in App.tsx): mod+W closes the
    // pod, mod+Shift+[ ] switches pods. Return false for exactly those so xterm
    // hands the keydown back to the DOM — where the window listener runs them —
    // instead of forwarding bytes to the shell. Only the platform's real
    // modifier is reserved, so Ctrl+W on macOS still reaches the shell as its
    // own delete-word.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return true;
      if (!e.shiftKey && e.code === "KeyW") return false;
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight"))
        return false;
      return true;
    });
    // xterm measures the cell grid the moment it opens, and the terminal
    // font is fetched over the network (or, for D2Coding, lazily from the
    // bundle) — so a pod that opens first is sized against the fallback font
    // and never re-measured, leaving the rendered text and the mouse-to-cell
    // mapping on slightly different grids.
    const initialPrimary = primaryFamily(initialMono);
    const fontLoaded = document.fonts.check(`13px ${initialPrimary}`);
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
      document.fonts.load(`13px ${initialPrimary}`).catch(() => {}).then(() => {
        if (disposed) return;
        // Round-trip the family so xterm re-measures with the real font.
        term.options.fontFamily = "monospace";
        term.options.fontFamily = initialMono;
        fit.fit();
      });
    }
    const unlisteners: Array<() => void> = [];

    // Reset on every connect, so the "died instantly" rule below judges the
    // latest attempt rather than the pod's whole life.
    let spawnedAt = Date.now();

    // tmux publishes the session's window list as the terminal title and
    // rewrites it on every change, so the header follows `Ctrl+B c` and
    // `Ctrl+B <n>` without anyone polling — see TITLE_FORMAT in the backends.
    // tmux repeats the title on attach and on redraws, so compare before
    // pushing: updateParameters re-renders the tab.
    let lastTitle = "";
    const titleSub = term.onTitleChange((title) => {
      if (disposed || title === lastTitle) return;
      const windows = parseWindowTitle(title);
      if (!windows) return;
      lastTitle = title;
      props.api.updateParameters({ windows });
    });

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

    // Every pod runs inside its OWN named tmux session (stable per pod id),
    // local or remote — so opening the same server twice gives two independent
    // sessions, and each pod restores its own content when the app is
    // reopened. The name is stable for the pod's whole life, which is what
    // lets a reconnect land back on the same work.
    const session = props.params.session ?? `omniagent-${podId}`;
    const ownsSession = !props.params.guest;

    /**
     * Attach a client to `session` — the first connection and every reconnect
     * after it. The pod id does not change, so the backend supersedes the dead
     * client and the listeners below keep feeding this same terminal.
     */
    const connect = async () => {
      setDropped(null);
      // Drop the window list with the old client: a layout restored from disk
      // carries the last session's windows, and they must not be shown as this
      // one's. tmux pushes the real list the moment the client attaches.
      lastTitle = "";
      props.api.updateParameters({
        status: "connecting",
        dropped: false,
        windows: [],
      });
      spawnedAt = Date.now();
      try {
        await ptySpawn(podId, host, session, term.rows, term.cols, ownsSession);
      } catch (e) {
        if (disposed) return;
        term.writeln(`\r\n\x1b[31m[OmniAgent] spawn failed: ${e}\x1b[0m`);
        props.api.updateParameters({ status: "exited", dropped: true });
        setDropped("unreachable");
        return;
      }
      if (disposed) return;
      props.api.updateParameters({ status: "running" });
      // Uptime counts the tmux session's life, which survives app restarts —
      // not when this pod happened to be opened.
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
    };
    reconnectRef.current = () => void connect();

    /**
     * Whether the work behind this pod is still there.
     *
     * A client exiting is two very different events wearing one face: the
     * session ended (an `exit`, someone killed it), or the connection to it
     * broke. Only the server can tell them apart. `tmux_sessions` answers with
     * the machine's id alongside its sessions, and that is what makes the
     * third answer possible — an empty machine id means nothing answered at
     * all. This probe rides the same network that just failed, so "no answer"
     * must never be read as "no session".
     */
    const sessionState = async (): Promise<"alive" | "gone" | "unreachable"> => {
      const list = await tmuxSessions(host).catch(() => ({
        machine: "",
        sessions: [],
      }));
      if (!list.machine) return "unreachable";
      return list.sessions.some((s) => s.name === session) ? "alive" : "gone";
    };

    const onClientGone = async () => {
      if (disposed) return;
      // Measured before the probe: a round trip to a sick host can take
      // seconds, and that must not make a pod that failed instantly look like
      // one that ran for a while.
      const livedFor = Date.now() - spawnedAt;
      const state = await sessionState();
      if (disposed) return;
      if (state === "gone") {
        // The session really is over — close the pod as before. Sessions that
        // die within 5s likely failed to connect, so keep those open with the
        // error output still readable.
        if (livedFor > 5000) {
          props.api.close();
        } else {
          props.api.updateParameters({ status: "exited" });
          term.writeln("\r\n\x1b[90m[OmniAgent] session ended\x1b[0m");
        }
        return;
      }
      // The work is still running; only the pipe to it broke. Closing the pod
      // now would strand the session — nothing would name it again — so keep
      // the pod and offer the way back.
      props.api.updateParameters({ status: "exited", dropped: true });
      setDropped(state);
      term.writeln(
        state === "alive"
          ? "\r\n\x1b[33m[OmniAgent] connection lost — the session is still running on the server\x1b[0m"
          : "\r\n\x1b[33m[OmniAgent] connection lost — the host is not answering\x1b[0m",
      );
    };

    // Fit after first layout, then spawn the PTY at the fitted size.
    requestAnimationFrame(async () => {
      if (disposed) return;
      fit.fit();
      // Subscribe BEFORE connecting: these listeners are keyed by pod id and
      // outlive any single client, so every reconnect reuses them — and no
      // output can slip past between the spawn and the subscription.
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
          void onClientGone();
        }),
      );
      if (disposed) return;
      await connect();
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
      reconnectRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      window.removeEventListener("keydown", onModKey);
      window.removeEventListener("keyup", onModKey);
      linkSub.dispose();
      titleSub.dispose();
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

  // Live font change (View → Font). Applying it to an open pod must repeat the
  // measurement dance the initial load uses: swap the family, wait for the new
  // font to actually be available, then fit() + ptyResize so the drawn grid
  // and the PTY's rows/cols — and the mouse-to-cell mapping — stay on one grid.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const mono = activeFont(settings).mono;
    if (term.options.fontFamily === mono) return;
    // Round-trip through a generic so xterm drops its glyph cache and remeasures.
    term.options.fontFamily = "monospace";
    term.options.fontFamily = mono;
    document.fonts
      .load(`13px ${primaryFamily(mono)}`)
      .catch(() => {})
      .then(() => {
        // The pod may have closed while the font loaded.
        if (termRef.current !== term) return;
        fit.fit();
        ptyResize(podId, term.rows, term.cols).catch(() => {});
      });
  }, [settings, podId]);

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
          {/* The terminal below still holds everything the session printed, so
              the banner sits above it rather than covering it. */}
          {dropped && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-y border-[#ffb960]/30 bg-[#ffb960]/10 text-[11px]">
              <span className="material-symbols-outlined text-[15px] text-[#ffb960] shrink-0">
                link_off
              </span>
              <span className="min-w-0 truncate text-on-surface-variant">
                {dropped === "alive"
                  ? "Connection lost — the tmux session is still running on the server."
                  : "Connection lost — the host is not answering. The session is untouched."}
              </span>
              <button
                onClick={() => reconnectRef.current?.()}
                className="ml-auto shrink-0 px-2 py-0.5 rounded bg-primary text-on-primary font-medium hover:opacity-90"
              >
                Reconnect
              </button>
            </div>
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

