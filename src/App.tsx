import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  themeDark,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import {
  layoutRead,
  layoutWrite,
  listSshHosts,
  onMenuAddFont,
  onMenuSetFont,
  onMenuSetPodBorder,
  ptyDetach,
  setFontMenu,
  setPodBorderMenu,
  shellName,
  SshHost,
} from "./ipc";
import { startWindowDrag } from "./window";
import { HostStats, subscribeHostStats } from "./hostStats";
import { fontOptions, selectFont, setSetting, useSettings } from "./settings";
import { PodParams, PodTab, TerminalPod } from "./components/TerminalPod";
import { Sessions } from "./components/Sessions";
import { FontManager } from "./components/FontManager";

const components = { terminal: TerminalPod };
const tabComponents = { pod: PodTab };

const LAYOUT_KEY = "omniagent.layout.v1";
// Pre-rename key, read once as a fallback so existing layouts migrate.
const LEGACY_LAYOUT_KEY = "omniterm.layout.v1";

// The modifier that carries the app's own shortcuts: ⌘ on macOS, Ctrl on
// Windows/Linux. Following each platform's convention is not just polish here —
// Ctrl+W on macOS is the shell's "delete previous word", so binding pod-close
// to it would hijack a key people lean on inside the terminal.
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

let podCounter = 0;

interface FleetSummary {
  working: number;
  idle: number;
  attention: number;
  total: number;
}

export default function App() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [sidebar, setSidebar] = useState<"fleet" | "sessions" | null>("fleet");
  const [podCount, setPodCount] = useState(0);
  const [fleet, setFleet] = useState<FleetSummary>({
    working: 0,
    idle: 0,
    attention: 0,
    total: 0,
  });
  const apiRef = useRef<DockviewApi | null>(null);
  const [fontManagerOpen, setFontManagerOpen] = useState(false);

  useEffect(() => {
    listSshHosts().then(setHosts).catch(console.error);
  }, []);

  // ⌘⇧I opens the IME diagnostic page. Korean input depends on whether this
  // webview reports composition events at all, which varies by machine — the
  // page answers that in one screen, and the same file opened in Safari says
  // whether the difference is WebKit's or the app's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.code === "KeyI") {
        e.preventDefault();
        location.href = new URL("ime-check.html", location.href).href;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pod keyboard shortcuts (⌘ on macOS, Ctrl elsewhere):
  //   • mod+W          — close the active pod, LEAVING its tmux session
  //                      running. That is the whole difference from the tab's
  //                      ✕, which kills the session: mod+W detaches, so the
  //                      work is still there next launch (and still on the
  //                      server right now, for a remote pod).
  //   • mod+Shift+[ ]  — step to the previous / next pod and focus it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const api = apiRef.current;
      if (!api) return;

      // Close the active pod, keeping its session. Detach on the backend
      // first, then remove the panel — the teardown's ptyKill then finds the
      // client already gone and never reaches its kill-session branch.
      if (!e.shiftKey && e.code === "KeyW") {
        const active = api.activePanel;
        if (!active) return;
        e.preventDefault();
        void ptyDetach(active.id).then(() => active.api.close());
        return;
      }

      // Cycle pods. Match on e.code (the physical bracket keys) because Shift
      // turns the characters into { and }, and wrap around at both ends.
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        const panels = api.panels;
        if (panels.length < 2) return;
        e.preventDefault();
        const current = api.activePanel?.id;
        const i = panels.findIndex((p) => p.id === current);
        const step = e.code === "BracketRight" ? 1 : -1;
        const next = panels[(i + step + panels.length) % panels.length];
        next.api.setActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // This machine's load, shown in the footer.
  const [localStats, setLocalStats] = useState<HostStats | null>(null);
  const settings = useSettings();
  useEffect(() => {
    if (!settings.meters) {
      setLocalStats(null);
      return;
    }
    return subscribeHostStats(null, setLocalStats);
  }, [settings.meters]);

  // The native Font menu (View → Font) is the entry point for the font
  // feature. Selecting an item applies it; "Add Local Font…" opens the manager.
  useEffect(() => {
    const offSet = onMenuSetFont((key) => selectFont(key));
    const offAdd = onMenuAddFont(() => setFontManagerOpen(true));
    const offBorder = onMenuSetPodBorder((on) => setSetting("activePodBorder", on));
    return () => {
      offSet();
      offAdd();
      offBorder();
    };
  }, []);

  // Keep the native menu in step with the renderer's font state — it owns the
  // list and the selection, so any change (add / remove / pick) is re-projected.
  useEffect(() => {
    setFontMenu(
      fontOptions(settings.customFonts).map((o) => ({
        key: o.key,
        label: o.label,
      })),
      settings.font,
    );
  }, [settings.font, settings.customFonts]);

  // Likewise for the pod-border checkbox, including the first run — the menu
  // is built before the renderer connects, so this is what corrects it.
  useEffect(() => {
    setPodBorderMenu(settings.activePodBorder);
  }, [settings.activePodBorder]);

  // Fleet health summary: poll pod activity params (cheap — a handful of
  // pods) so the header always shows who is working and who is stuck.
  useEffect(() => {
    const t = setInterval(() => {
      const panels = apiRef.current?.panels ?? [];
      const s: FleetSummary = { working: 0, idle: 0, attention: 0, total: panels.length };
      for (const p of panels) {
        const prm = p.params as PodParams | undefined;
        if (prm?.status !== "running") continue;
        if (prm.activity === "attention") s.attention++;
        else if (prm.activity === "working") s.working++;
        else s.idle++;
      }
      setFleet((prev) =>
        prev.working === s.working &&
        prev.idle === s.idle &&
        prev.attention === s.attention &&
        prev.total === s.total
          ? prev
          : s,
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const openPod = (host: string | null, session?: string) => {
    const api = apiRef.current;
    if (!api) return;
    podCounter += 1;
    const name = session?.replace(/^omniagent-/, "");
    api.addPanel<PodParams>({
      id: `pod-${podCounter}`,
      component: "terminal",
      tabComponent: "pod",
      title: host ? `[${host.toUpperCase()}]` : "[LOCAL]",
      params: {
        host,
        label: session
          ? `${host ?? "local"} · ${name}`
          : host
            ? `${host} · SSH`
            : "LOCAL · SHELL",
        status: "connecting",
        session,
        guest: session !== undefined,
      },
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
    // to their tmux session, so terminal content survives too). The layout
    // comes from a file rather than localStorage so that switching between the
    // Electron and Tauri builds — which have separate webview storage — lands
    // on the same pods, the way the tmux sessions behind them already do.
    const restore = async () => {
      const saved =
        (await layoutRead().catch(() => null)) ??
        localStorage.getItem(LAYOUT_KEY) ??
        localStorage.getItem(LEGACY_LAYOUT_KEY);
      if (!saved) return;
      try {
        event.api.fromJSON(JSON.parse(saved));
        for (const p of event.api.panels) {
          const m = /^pod-(\d+)$/.exec(p.id);
          if (m) podCounter = Math.max(podCounter, Number(m[1]));
        }
      } catch (e) {
        console.error("[OmniAgent] layout restore failed:", e);
      }
      sync();
    };
    void restore();

    // Persist every layout change (add/close/move/resize), debounced.
    let timer: number | undefined;
    event.api.onDidLayoutChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void layoutWrite(JSON.stringify(event.api.toJSON())).catch(() => {});
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
    try {
      // Gather every pod into the first group, then split back out.
      const first = panels[0];
      for (let i = 1; i < panels.length; i++) {
        if (panels[i].group !== first.group) {
          panels[i].api.moveTo({
            group: first.group,
            position: "center",
            index: i,
          });
        }
      }
      // Split row LEADERS downward first (while each row still spans the
      // full width), THEN fill rows rightward — otherwise an early right
      // split leaves a column spanning every row.
      for (let i = cols; i < panels.length; i += cols) {
        panels[i].api.moveTo({
          group: panels[i - cols].group,
          position: "bottom",
        });
      }
      for (let i = 1; i < panels.length; i++) {
        if (i % cols !== 0) {
          panels[i].api.moveTo({
            group: panels[i - 1].group,
            position: "right",
          });
        }
      }
      first.api.setActive();
    } catch (e) {
      console.error("[OmniAgent] preset layout failed:", e);
    }
  };

  /** COLS: every pod side by side as vertical columns (one row). */
  const applyColumns = () => {
    const n = apiRef.current?.panels.length ?? 0;
    if (n > 0) applyGrid(n);
  };

  /** AUTO: balanced grid — 2+ rows once there are enough pods (≈√N cols). */
  const applyAuto = () => {
    const n = apiRef.current?.panels.length ?? 0;
    if (n > 0) applyGrid(Math.ceil(Math.sqrt(n)));
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-surface text-on-surface">
      {/* Custom title bar strip — native traffic lights overlay this area, so
          it doubles as the window drag region. Electron gets that from the
          app-region style; Tauri has no such property and drags through its
          own API instead. */}
      <div
        className="h-9 shrink-0 bg-surface-container-lowest border-b border-surface-container-highest flex items-center justify-center relative"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        onMouseDown={startWindowDrag}
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
          {/* Both shells ship under the same name, icon and version — say
              which one this is, so a bug report can start from that. */}
          <span className="text-[10px] text-outline/70 tracking-wider border border-surface-container-highest rounded px-1.5 py-px">
            {shellName}
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
              sidebar === "fleet"
                ? "text-primary border-primary"
                : "text-on-surface-variant border-transparent hover:text-on-surface"
            }`}
            title="Fleet (SSH hosts)"
            onClick={() => setSidebar((v) => (v === "fleet" ? null : "fleet"))}
          >
            <span className="material-symbols-outlined">grid_view</span>
          </button>
          <button
            className={`flex items-center justify-center w-full py-2 border-l-2 ${
              sidebar === "sessions"
                ? "text-primary border-primary"
                : "text-on-surface-variant border-transparent hover:text-on-surface"
            }`}
            title="Running tmux sessions"
            onClick={() =>
              setSidebar((v) => (v === "sessions" ? null : "sessions"))
            }
          >
            <span className="material-symbols-outlined">lan</span>
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
          <div className="flex items-center gap-4 text-on-surface-variant">
            {fleet.attention > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#ffb960] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-[#ffb960]" />
                {fleet.attention} NEEDS INPUT
              </span>
            )}
            {fleet.working > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-secondary">
                <span className="w-2 h-2 rounded-full bg-secondary" />
                {fleet.working} WORKING
              </span>
            )}
            {fleet.idle > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
                <span className="w-2 h-2 rounded-full bg-outline" />
                {fleet.idle} IDLE
              </span>
            )}
            <span className="font-mono text-[11px]">
              {podCount} POD{podCount === 1 ? "" : "S"}
            </span>
          </div>
        </header>

        <div className="flex flex-1 min-h-0">
          {/* Host sidebar — auto-populated from ~/.ssh/config (zero-config) */}
          {sidebar === "sessions" && (
            <aside className="w-sidebar-width shrink-0 bg-surface-container-lowest border-r border-surface-container-highest flex flex-col">
              <Sessions
                hosts={hosts}
                onOpen={openPod}
                openSessions={() =>
                  new Set(
                    (apiRef.current?.panels ?? []).map((p) => {
                      const prm = p.params as PodParams | undefined;
                      return `${prm?.host ?? "local"}:${prm?.session ?? `omniagent-${p.id}`}`;
                    }),
                  )
                }
              />
            </aside>
          )}
          {sidebar === "fleet" && (
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

          {/* Pod grid. `pods-multi` turns on the focus ring drawn around the
              active pod (index.css) — with one pod there is nothing to tell
              apart, so the ring only appears once a second one opens, and only
              while View → Active Pod Border is on. */}
          <main
            className={`flex-1 min-w-0 bg-surface relative ${
              podCount > 1 && settings.activePodBorder ? "pods-multi" : ""
            }`}
          >
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
              tabComponents={tabComponents}
              onReady={onReady}
              theme={themeDark}
              singleTabMode="fullwidth"
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
                title="All pods side by side as columns"
                onClick={applyColumns}
              >
                COLS
              </button>
              <button
                className="px-2 py-0.5 text-[11px] text-on-surface-variant hover:text-on-surface hover:bg-surface-variant rounded"
                title="Balanced grid (2+ rows when there are enough pods)"
                onClick={applyAuto}
              >
                AUTO
              </button>
            </div>
            <div className="h-4 w-px bg-outline-variant" />
            <span className="text-[11px] text-on-surface-variant">
              {hosts.length} HOSTS DISCOVERED
            </span>
            <div className="h-4 w-px bg-outline-variant" />
            <span
              className={`material-symbols-outlined text-[16px] cursor-pointer ${
                settings.meters
                  ? "text-secondary"
                  : "text-outline hover:text-on-surface-variant"
              }`}
              title={
                settings.meters
                  ? "Resource monitoring on — click to stop polling"
                  : "Resource monitoring off"
              }
              onClick={() => setSetting("meters", !settings.meters)}
            >
              {settings.meters ? "monitor_heart" : "monitoring"}
            </span>
            {localStats && localStats.mem_total_mb > 0 && (
              <>
                <div className="h-4 w-px bg-outline-variant" />
                <span
                  className="flex items-center gap-2 text-[11px] text-on-surface-variant"
                  title="This machine"
                >
                  <span>CPU</span>
                  <span className="w-16 h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
                    <span
                      className={`block h-full ${
                        localStats.cpu > 85 ? "bg-error" : "bg-secondary"
                      }`}
                      style={{ width: `${Math.min(100, localStats.cpu)}%` }}
                    />
                  </span>
                  <span className="font-mono">{localStats.cpu.toFixed(0)}%</span>
                  <span className="ml-2">RAM</span>
                  <span className="w-16 h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
                    <span
                      className="block h-full bg-primary-container"
                      style={{
                        width: `${Math.min(
                          100,
                          (localStats.mem_used_mb / localStats.mem_total_mb) * 100,
                        )}%`,
                      }}
                    />
                  </span>
                  <span className="font-mono">
                    {(localStats.mem_used_mb / 1024).toFixed(1)}GB
                  </span>
                </span>
              </>
            )}
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
      {fontManagerOpen && (
        <FontManager onClose={() => setFontManagerOpen(false)} />
      )}
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
