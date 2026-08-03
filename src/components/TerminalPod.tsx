import {
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  BrowserClipboardProvider,
  ClipboardAddon,
} from "@xterm/addon-clipboard";
import {
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../ipc";
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

/**
 * Pod state shared between the panel (terminal body) and its tab (header).
 * Lives in dockview params so both sides see updates and it serializes with
 * the layout.
 */
export interface PodParams {
  host: string | null; // null = local shell
  label: string;
  status?: PodStatus;
  startedAt?: number;
  explorerOpen?: boolean;
  editorOpen?: boolean;
}

/**
 * WKWebView's Korean IME never fires composition events — it rewrites the
 * hidden textarea through plain `input` events (isComposing=false) with
 * keyCode-229 keydowns, replacing the composing tail in place (ㅎ→하→한).
 * xterm's built-in handling emits only the first jamo of each syllable and
 * drops the composed character. This bridge takes over text insertion:
 * printable keys are routed through the textarea and emitted from value
 * diffs — the last char is held while it may still be composing and is
 * flushed on syllable boundaries, ASCII input, or control keys. Control
 * keys (Enter, arrows, shortcuts) keep xterm's normal path.
 */
function setupImeBridge(term: Terminal, rawSend: (data: string) => void) {
  const ta = term.textarea;
  if (!ta) return;
  let committed = 0;

  // WebKit inserts non-breaking spaces (U+00A0) into the textarea where the
  // user typed plain spaces — invisible in logs, but the shell treats
  // "cd wo" as ONE word, silently breaking completion and commands.
  const send = (data: string) => rawSend(data.replace(/\u00a0/g, " "));

  const isComposable = (code: number) =>
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) || // Compatibility Jamo
    (code >= 0xac00 && code <= 0xd7a3); // Hangul Syllables

  const resetIfIdle = () => {
    if (committed >= ta.value.length) {
      ta.value = "";
      committed = 0;
    }
  };

  const flushPending = () => {
    if (ta.value.length > committed) {
      send(ta.value.slice(committed));
      committed = ta.value.length;
    }
    resetIfIdle();
  };

  // Keep keyCode-229 keydowns away from xterm entirely: its
  // CompositionHelper arms a textarea-diff timer on 229 that races this
  // bridge and double-emits characters. The default action still reaches
  // the textarea, which is all the IME needs.
  // Track whether a Backspace press was actually handled this cycle —
  // WebKit sometimes swallows the keydown whole (only a keyup arrives),
  // especially right after a composition, and the deletion would be lost.
  let bsHandled = false;
  term.element?.addEventListener(
    "keydown",
    (e) => {
      if (e.keyCode === 229) {
        // IME-mediated Backspace edits the composing tail locally.
        if (e.key === "Backspace") bsHandled = true;
        e.stopPropagation();
      }
    },
    { capture: true },
  );
  term.element?.addEventListener(
    "keyup",
    (e) => {
      if (e.keyCode === 8 || e.key === "Backspace") {
        if (!bsHandled) send("\x7f");
        bsHandled = false;
      }
    },
    { capture: true },
  );

  const MODIFIER_KEYS = new Set([
    "Shift",
    "Control",
    "Alt",
    "Meta",
    "CapsLock",
    "Dead",
  ]);

  term.attachCustomKeyEventHandler((ev) => {
    const printable =
      ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    // The input-diff path owns printable characters on every event type —
    // otherwise xterm's keypress handler emits them a second time.
    if (ev.type === "keypress") return !printable;
    if (ev.type !== "keydown") return true;
    if (printable) return false;
    // Bare modifiers must NOT finalize the syllable being composed —
    // Shift is literally part of typing ㅆ/ㅃ/ㅆ받침.
    if (MODIFIER_KEYS.has(ev.key)) return true;
    if (ev.keyCode === 8) {
      // Composing: Backspace edits the tail locally in the textarea.
      if (ta.value.length > committed) {
        bsHandled = true;
        return false;
      }
      // Otherwise xterm sends \x7f to the terminal.
      bsHandled = true;
      flushPending();
      return true;
    }
    // Any other control key finalizes the pending syllable first.
    flushPending();
    return true;
  });

  term.element?.addEventListener(
    "input",
    (e) => {
      if (e.target !== ta) return;
      // We own insertText emission; keep xterm's handler out of it.
      e.stopPropagation();
      const val = ta.value;
      if (val.length < committed) {
        committed = val.length;
        return;
      }
      if (val.length === committed) return;
      const lastCode = val.charCodeAt(val.length - 1);
      // Hold the last char while it may still be composing.
      const finalTo = isComposable(lastCode) ? val.length - 1 : val.length;
      if (finalTo > committed) {
        send(val.slice(committed, finalTo));
        committed = finalTo;
      }
      resetIfIdle();
    },
    { capture: true },
  );

  // xterm clears its textarea on focus — resync.
  ta.addEventListener("focus", () => {
    setTimeout(() => {
      committed = Math.min(committed, ta.value.length);
    }, 0);
  });
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
export function PodTab(props: IDockviewPanelHeaderProps<PodParams>) {
  const {
    label,
    status = "connecting",
    startedAt,
    explorerOpen,
    editorOpen,
  } = props.params;
  const [maximized, setMaximized] = useState(false);
  const [, tick] = useState(0);

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
    status === "running"
      ? "bg-secondary shadow-[0_0_8px_rgba(97,218,193,0.4)]"
      : status === "connecting"
        ? "bg-tertiary animate-pulse"
        : "bg-error";

  // Keep button clicks from starting a tab drag.
  const guard = (e: React.MouseEvent) => e.stopPropagation();

  const iconClass = (active: boolean | undefined) =>
    `material-symbols-outlined text-[16px] cursor-pointer ${
      active ? "text-primary" : "text-on-surface-variant hover:text-on-surface"
    }`;

  return (
    <div className="flex items-center justify-between gap-4 h-full w-full px-3 cursor-grab active:cursor-grabbing select-none">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-[11px] font-medium text-on-surface uppercase tracking-wider truncate">
          {label}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
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
  const [editorPath, setEditorPath] = useState<string | null>(null);

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
    term.open(el);

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const spawnedAt = Date.now();

    // Fit after first layout, then spawn the PTY at the fitted size.
    requestAnimationFrame(async () => {
      if (disposed) return;
      fit.fit();
      try {
        // Every pod runs inside its OWN named tmux session (stable per pod
        // id), local or remote — so opening the same server twice gives two
        // independent sessions, and each pod restores its own content when
        // the app is reopened.
        const session = `omniagent-${podId}`;
        await ptySpawn(podId, host, session, term.rows, term.cols);
        if (!disposed) {
          props.api.updateParameters({
            status: "running",
            startedAt: Date.now(),
          });
        }
      } catch (e) {
        term.writeln(`\x1b[31m[OmniAgent] spawn failed: ${e}\x1b[0m`);
        props.api.updateParameters({ status: "exited" });
        return;
      }

      unlisteners.push(
        await onPtyOutput(({ id, data }) => {
          if (id === podId) term.write(data);
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
      writeChain = writeChain.then(() =>
        ptyWrite(podId, data).catch(() => {}),
      );
    };
    const dataSub = term.onData(write);
    setupImeBridge(term, write);

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
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
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
          <Explorer
            host={host}
            onOpenFile={(path) => {
              setEditorPath(path);
              props.api.updateParameters({ editorOpen: true });
            }}
          />
        )}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {editorOpen && (
            <EditorPanel
              host={host}
              path={editorPath}
              onClose={() => props.api.updateParameters({ editorOpen: false })}
            />
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
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

