import { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

export interface PodParams {
  host: string | null; // null = local shell
  label: string;
}

type PodStatus = "connecting" | "running" | "exited";

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

export function TerminalPod(props: IDockviewPanelProps<PodParams>) {
  const { host, label } = props.params;
  const podId = props.api.id;
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PodStatus>("connecting");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [, tick] = useState(0);

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
    term.open(el);

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const spawnedAt = Date.now();

    // Fit after first layout, then spawn the PTY at the fitted size.
    requestAnimationFrame(async () => {
      if (disposed) return;
      fit.fit();
      try {
        // Local pods run inside a named tmux session (stable per pod id) so
        // their content is restored when the app is reopened.
        const session = host ? null : `omniagent-${podId}`;
        await ptySpawn(podId, host, session, term.rows, term.cols);
        if (!disposed) setStatus("running");
      } catch (e) {
        term.writeln(`\x1b[31m[OmniAgent] spawn failed: ${e}\x1b[0m`);
        setStatus("exited");
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
            setStatus("exited");
            term.writeln("\r\n\x1b[90m[OmniAgent] session ended\x1b[0m");
          }
        }),
      );
    });

    const dataSub = term.onData((data) => {
      ptyWrite(podId, data).catch(() => {});
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

  // Keep the maximize icon in sync when maximize state changes elsewhere
  // (footer FOCUS preset, esc, another pod maximizing).
  useEffect(() => {
    const sub = props.containerApi.onDidMaximizedGroupChange(() =>
      setMaximized(props.api.isMaximized()),
    );
    return () => sub.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Uptime ticker for the pod header.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const uptime = formatUptime(Date.now() - startedAt);
  const dotClass =
    status === "running"
      ? "bg-secondary shadow-[0_0_8px_rgba(97,218,193,0.4)]"
      : status === "connecting"
        ? "bg-tertiary animate-pulse"
        : "bg-error";

  return (
    <div className="flex flex-col h-full bg-surface-container-low">
      {/* Pod header */}
      <div className="h-8 shrink-0 bg-surface-container border-b border-surface-container-highest flex items-center justify-between px-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
          <span className="text-[11px] font-medium text-on-surface uppercase tracking-wider truncate">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-mono text-on-surface-variant text-[11px]">
            {status === "exited" ? "ENDED" : `UP ${uptime}`}
          </span>
          <span
            className={`material-symbols-outlined text-[16px] cursor-pointer ${
              explorerOpen
                ? "text-primary"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
            title="Toggle explorer"
            onClick={() => setExplorerOpen((v) => !v)}
          >
            folder_open
          </span>
          <span
            className={`material-symbols-outlined text-[16px] cursor-pointer ${
              editorOpen
                ? "text-primary"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
            title="Toggle editor"
            onClick={() => setEditorOpen((v) => !v)}
          >
            description
          </span>
          <span
            className={`material-symbols-outlined text-[16px] cursor-pointer ${
              maximized
                ? "text-primary"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
            title={maximized ? "Restore pod" : "Maximize pod"}
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
        </div>
      </div>
      {/* Pod body: explorer | (editor above / terminal below — VS Code style) */}
      <div className="flex flex-1 min-h-0">
        {explorerOpen && (
          <Explorer
            host={host}
            onOpenFile={(path) => {
              setEditorPath(path);
              setEditorOpen(true);
            }}
          />
        )}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {editorOpen && (
            <EditorPanel
              host={host}
              path={editorPath}
              onClose={() => setEditorOpen(false)}
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
