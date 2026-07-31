import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  themeDark,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listSshHosts, SshHost } from "./ipc";
import { PodParams, TerminalPod } from "./components/TerminalPod";

const components = { terminal: TerminalPod };

const LAYOUT_KEY = "omniagent.layout.v1";
// Pre-rename key, read once as a fallback so existing layouts migrate.
const LEGACY_LAYOUT_KEY = "omniterm.layout.v1";

let podCounter = 0;

export default function App() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [podCount, setPodCount] = useState(0);
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    listSshHosts().then(setHosts).catch(console.error);
  }, []);

  const openPod = (host: string | null) => {
    const api = apiRef.current;
    if (!api) return;
    podCounter += 1;
    api.addPanel<PodParams>({
      id: `pod-${podCounter}`,
      component: "terminal",
      title: host ? `[${host.toUpperCase()}]` : "[LOCAL]",
      params: { host, label: host ? `${host} · SSH` : "LOCAL · SHELL" },
      // Split right of the active group so pods tile into a grid instead of
      // stacking as tabs.
      position: api.activePanel
        ? { referencePanel: api.activePanel.id, direction: "right" }
        : undefined,
    });
  };

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const sync = () => setPodCount(event.api.panels.length);
    event.api.onDidRemovePanel(sync);
    event.api.onDidAddPanel(sync);

    // Restore the previous session: pods reopen with the same hosts and grid
    // arrangement, and each pod re-spawns its connection (remote pods reattach
    // to their tmux session, so terminal content survives too).
    const saved =
      localStorage.getItem(LAYOUT_KEY) ??
      localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (saved) {
      try {
        event.api.fromJSON(JSON.parse(saved));
        for (const p of event.api.panels) {
          const m = /^pod-(\d+)$/.exec(p.id);
          if (m) podCounter = Math.max(podCounter, Number(m[1]));
        }
      } catch (e) {
        console.error("[OmniAgent] layout restore failed:", e);
        localStorage.removeItem(LAYOUT_KEY);
      }
      sync();
    }

    // Persist every layout change (add/close/move/resize), debounced.
    let timer: number | undefined;
    event.api.onDidLayoutChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(event.api.toJSON()));
      }, 500);
    });
  };

  /** Re-tile all pods into a grid with the given number of columns. */
  const applyGrid = (cols: number) => {
    const api = apiRef.current;
    if (!api) return;
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
    const panels = [...api.panels];
    if (panels.length < 2) return;
    // Gather every pod into the first group, then split back out row by row.
    const first = panels[0];
    for (let i = 1; i < panels.length; i++) {
      panels[i].api.moveTo({ group: first.group, position: "center", index: i });
    }
    for (let i = 1; i < panels.length; i++) {
      if (i % cols !== 0) {
        panels[i].api.moveTo({ group: panels[i - 1].group, position: "right" });
      } else {
        panels[i].api.moveTo({ group: panels[i - cols].group, position: "bottom" });
      }
    }
    first.api.setActive();
  };

  /** Toggle-maximize the active pod. */
  const toggleFocus = () => {
    const api = apiRef.current;
    if (!api) return;
    if (api.hasMaximizedGroup()) {
      api.exitMaximizedGroup();
    } else if (api.activePanel) {
      api.activePanel.api.maximize();
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-surface text-on-surface">
      {/* Custom title bar strip — native traffic lights overlay this area
          (titleBarStyle: Overlay), so it doubles as the window drag region. */}
      <div
        className="h-9 shrink-0 bg-surface-container-lowest border-b border-surface-container-highest flex items-center justify-center relative"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const win = getCurrentWindow();
          if (e.detail === 2) win.toggleMaximize();
          else win.startDragging();
        }}
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <div className="w-5 h-5 bg-primary rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-on-primary text-[14px]">
              hub
            </span>
          </div>
          <span className="text-[12px] font-semibold tracking-[0.2em] uppercase text-on-surface">
            OmniAgent
          </span>
          <span className="text-[11px] text-outline tracking-widest">
            CONTROL TOWER
          </span>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
      {/* Activity bar */}
      <aside className="w-activity-bar-width shrink-0 bg-surface-container-lowest border-r border-surface-container-highest flex flex-col items-center py-4 gap-4">
        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center mb-2">
          <span className="material-symbols-outlined text-on-primary text-[20px]">
            hub
          </span>
        </div>
        <nav className="flex flex-col gap-4 w-full items-center">
          <button
            className={`flex items-center justify-center w-full py-2 border-l-2 ${
              sidebarOpen
                ? "text-primary border-primary"
                : "text-on-surface-variant border-transparent hover:text-on-surface"
            }`}
            title="Fleet (SSH hosts)"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <span className="material-symbols-outlined">grid_view</span>
          </button>
          <button
            className="flex items-center justify-center w-full py-2 text-on-surface-variant hover:text-on-surface border-l-2 border-transparent"
            title="New local terminal"
            onClick={() => openPod(null)}
          >
            <span className="material-symbols-outlined">terminal</span>
          </button>
        </nav>
        <div className="mt-auto mb-2">
          <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center border border-surface-container-highest">
            <span className="material-symbols-outlined text-[18px]">person</span>
          </div>
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <header className="h-tab-height shrink-0 border-b border-surface-container-highest bg-surface-container-lowest flex items-center justify-between px-3">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-semibold tracking-widest uppercase text-on-surface-variant">
              Control Tower
            </span>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-medium">Global Fleet</span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant">
            <span className="font-mono text-[11px]">
              {podCount} POD{podCount === 1 ? "" : "S"}
            </span>
          </div>
        </header>

        <div className="flex flex-1 min-h-0">
          {/* Host sidebar — auto-populated from ~/.ssh/config (zero-config) */}
          {sidebarOpen && (
            <aside className="w-sidebar-width shrink-0 bg-surface-container-lowest border-r border-surface-container-highest flex flex-col">
              <div className="h-8 shrink-0 flex items-center px-3 border-b border-surface-container-highest">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant">
                  ~/.ssh/config
                </span>
              </div>
              <div className="flex-1 overflow-auto py-1">
                <SidebarItem
                  icon="computer"
                  label="Local Terminal"
                  sub="This machine"
                  accent
                  onClick={() => openPod(null)}
                />
                {hosts.map((h) => (
                  <SidebarItem
                    key={h.host}
                    icon="dns"
                    label={h.host}
                    sub={
                      h.hostname
                        ? `${h.user ? `${h.user}@` : ""}${h.hostname}${
                            h.port ? `:${h.port}` : ""
                          }`
                        : ""
                    }
                    onClick={() => openPod(h.host)}
                  />
                ))}
                {hosts.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-outline">
                    No hosts found in ~/.ssh/config
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* Pod grid */}
          <main className="flex-1 min-w-0 bg-surface relative">
            {podCount === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-outline z-10 pointer-events-none">
                <span className="material-symbols-outlined text-[48px]">
                  grid_view
                </span>
                <span className="text-[12px]">
                  Select a host on the left — or open a local terminal — to
                  launch a pod
                </span>
              </div>
            )}
            <DockviewReact
              components={components}
              onReady={onReady}
              theme={themeDark}
            />
          </main>
        </div>

        {/* Footer */}
        <footer className="h-tab-height shrink-0 border-t border-surface-container-highest bg-surface-container-low flex items-center justify-between px-3">
          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-1.5 px-2 py-1 bg-primary text-on-primary rounded text-[11px] font-medium hover:opacity-90"
              onClick={() => openPod(null)}
            >
              <span className="material-symbols-outlined text-[14px]">add</span>
              NEW AGENT
            </button>
            <div className="h-4 w-px bg-outline-variant" />
            <span className="text-[11px] text-on-surface-variant">PRESETS:</span>
            <div className="flex bg-surface-container-highest rounded p-0.5 gap-0.5">
              <button
                className="px-2 py-0.5 text-[11px] text-on-surface-variant hover:text-on-surface hover:bg-surface-variant rounded"
                title="Tile pods in 2 columns"
                onClick={() => applyGrid(2)}
              >
                2x2
              </button>
              <button
                className="px-2 py-0.5 text-[11px] text-on-surface-variant hover:text-on-surface hover:bg-surface-variant rounded"
                title="Tile pods in 3 columns"
                onClick={() => applyGrid(3)}
              >
                3-COL
              </button>
              <button
                className="px-2 py-0.5 text-[11px] text-on-surface-variant hover:text-on-surface hover:bg-surface-variant rounded"
                title="Maximize active pod (toggle)"
                onClick={toggleFocus}
              >
                FOCUS
              </button>
            </div>
            <div className="h-4 w-px bg-outline-variant" />
            <span className="text-[11px] text-on-surface-variant">
              {hosts.length} HOSTS DISCOVERED
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-secondary">
            <span className="material-symbols-outlined text-[14px]">
              check_circle
            </span>
            <span className="text-[11px] font-medium">SYSTEM UP</span>
          </div>
        </footer>
      </div>
      </div>
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  sub,
  accent,
  onClick,
}: {
  icon: string;
  label: string;
  sub: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-container-high cursor-pointer"
      onClick={onClick}
    >
      <span
        className={`material-symbols-outlined text-[18px] ${
          accent ? "text-secondary" : "text-primary"
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[12px] text-on-surface truncate">{label}</div>
        {sub && (
          <div className="text-[10px] font-mono text-outline truncate">{sub}</div>
        )}
      </div>
    </div>
  );
}
