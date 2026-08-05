import { useEffect, useState } from "react";
import { SshHost, TmuxSession, tmuxKillSession, tmuxSessions } from "../ipc";

interface HostSessions {
  host: string | null;
  label: string;
  /** Stable id of the box this alias reached, once it has answered. */
  machine: string;
  ours: TmuxSession[];
  theirs: TmuxSession[];
  loading: boolean;
}

/** Pods name their sessions this way; everything else came from elsewhere. */
const OURS = /^omniagent-/;

/**
 * Last answer per host, kept across mounts so reopening the panel shows the
 * previous list at once and refreshes underneath. Sessions change on the scale
 * of minutes; a stale row for a second is better than an empty panel.
 */
const cache = new Map<string, { machine: string; sessions: TmuxSession[] }>();
const keyOf = (host: string | null) => host ?? " local";

function age(created: number): string {
  if (!created) return "";
  const mins = Math.max(0, Math.floor(Date.now() / 1000 - created) / 60);
  if (mins < 60) return `${Math.floor(mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Every tmux session across the fleet, split into the ones pods created and
 * the ones that were already there.
 *
 * The sessions outlive the app — they survive a quit, a crash, and switching
 * between the two builds — so this is the honest picture of what is running,
 * and the way back into work the app has forgotten about. Opening one attaches
 * to it; the pod is a guest and will not kill it on close.
 */
export function Sessions({
  hosts,
  onOpen,
  openSessions,
}: {
  hosts: SshHost[];
  onOpen: (host: string | null, session: string) => void;
  /** `host:name` for every session a pod is currently showing. */
  openSessions: () => Set<string>;
}) {
  const [rows, setRows] = useState<HostSessions[]>([]);
  // Bumped by the refresh button. Closing a pod ends its session, and the
  // panel has no way to hear about that.
  const [reload, setReload] = useState(0);
  /** The row asking to be confirmed, `host:name`. Ending a session is final. */
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    const targets: { host: string | null; label: string }[] = [
      { host: null, label: "local" },
      ...hosts.map((h) => ({ host: h.host, label: h.host })),
    ];
    const split = (list: TmuxSession[]) => ({
      ours: list.filter((s) => OURS.test(s.name)),
      theirs: list.filter((s) => !OURS.test(s.name)),
    });
    setRows(
      targets.map((t) => {
        const known = reload ? undefined : cache.get(keyOf(t.host));
        return {
          ...t,
          machine: known?.machine ?? "",
          ...split(known?.sessions ?? []),
          loading: !known,
        };
      }),
    );

    let cancelled = false;
    for (const t of targets) {
      // Each host answers on its own — one slow ssh must not hold up the rest.
      tmuxSessions(t.host)
        .catch(() => ({ machine: "", sessions: [] }))
        .then((list) => {
          cache.set(keyOf(t.host), list);
          if (cancelled) return;
          setRows((prev) =>
            prev.map((r) =>
              r.host === t.host
                ? { ...r, loading: false, machine: list.machine, ...split(list.sessions) }
                : r,
            ),
          );
        });
    }
    return () => {
      cancelled = true;
    };
  }, [hosts, reload]);

  /**
   * One entry per machine, not per alias. Several `Host` entries can reach the
   * same server by different routes; each answers with the same sessions, and
   * listing them once — noting how many ways in there are — is the truth.
   * Connecting still goes through a named alias, since the route is what makes
   * the machine reachable from where you are.
   */
  const machines = rows.reduce<(HostSessions & { routes: string[] })[]>(
    (acc, r) => {
      const same = r.machine
        ? acc.find((m) => m.machine === r.machine)
        : undefined;
      if (same) same.routes.push(r.label);
      else acc.push({ ...r, routes: [r.label] });
      return acc;
    },
    [],
  );

  const kill = async (host: string | null, name: string) => {
    setConfirming(null);
    await tmuxKillSession(host, name).catch(() => {});
    setReload((n) => n + 1);
  };

  /**
   * Everything this app started and then lost track of — a pod closed by the
   * window manager, a crash, a session left behind by an earlier version.
   * Sessions the app did not create are never touched in bulk; they belong to
   * whoever started them and can be ended one at a time.
   */
  const strays = () => {
    const open = openSessions();
    return machines.flatMap((r) =>
      r.ours
        .filter((s) => !open.has(`${r.host ?? "local"}:${s.name}`))
        .map((s) => ({ host: r.host, name: s.name })),
    );
  };

  const sweep = async () => {
    setConfirming(null);
    await Promise.all(strays().map((s) => tmuxKillSession(s.host, s.name).catch(() => {})));
    setReload((n) => n + 1);
  };

  const item = (host: string | null, s: TmuxSession, ours: boolean) => {
    const id = `${host ?? "local"}:${s.name}`;
    return (
      <div
        key={id}
        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-container-high group"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            s.attached ? "bg-secondary" : "bg-outline"
          }`}
        />
        <button
          onClick={() => onOpen(host, s.name)}
          title={`${s.windows} window${s.windows === 1 ? "" : "s"}${
            s.attached ? " · attached" : ""
          }`}
          className={`flex-1 min-w-0 text-left text-[11px] truncate ${
            ours ? "text-on-surface" : "text-on-surface-variant"
          }`}
        >
          {ours ? s.name.replace(OURS, "") : s.name}
        </button>
        {confirming === id ? (
          <>
            <button
              onClick={() => kill(host, s.name)}
              className="text-[10px] text-error hover:underline shrink-0"
            >
              end it
            </button>
            <button
              onClick={() => setConfirming(null)}
              className="text-[10px] text-outline hover:text-on-surface shrink-0"
            >
              keep
            </button>
          </>
        ) : (
          <>
            <span className="text-[10px] text-outline font-mono shrink-0 group-hover:hidden">
              {age(s.created)}
            </span>
            <button
              onClick={() => setConfirming(id)}
              title="End this session"
              // Whatever is running inside dies with it, so the click only
              // arms the question — the second one does it.
              className="hidden group-hover:block text-outline hover:text-error shrink-0"
            >
              <span className="material-symbols-outlined text-[14px] block">
                close
              </span>
            </button>
          </>
        )}
      </div>
    );
  };

  const total = machines.reduce((n, r) => n + r.ours.length + r.theirs.length, 0);
  const busy = rows.some((r) => r.loading);

  return (
    <>
      <div className="h-8 shrink-0 flex items-center px-3 border-b border-surface-container-highest">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant">
          tmux sessions
        </span>
        {confirming === "sweep" ? (
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={sweep}
              className="text-[10px] text-error hover:underline"
            >
              end {strays().length}
            </button>
            <button
              onClick={() => setConfirming(null)}
              className="text-[10px] text-outline hover:text-on-surface"
            >
              keep
            </button>
          </span>
        ) : (
          <button
            className="ml-auto text-on-surface-variant hover:text-error disabled:opacity-30"
            title="End every OmniAgent session that no pod is showing"
            disabled={busy || strays().length === 0}
            onClick={() => setConfirming("sweep")}
          >
            <span className="material-symbols-outlined text-[15px] block">
              cleaning_services
            </span>
          </button>
        )}
        <button
          className="ml-2 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
          title="Refresh"
          disabled={busy}
          onClick={() => setReload((n) => n + 1)}
        >
          <span
            className={`material-symbols-outlined text-[15px] block ${
              busy ? "animate-spin" : ""
            }`}
          >
            refresh
          </span>
        </button>
      </div>
      <div className="flex flex-col gap-3 p-2 overflow-y-auto">
      {machines.map((r) => {
        if (!r.loading && !r.ours.length && !r.theirs.length) return null;
        return (
          <div key={r.host ?? "local"}>
            <div className="px-2 pb-1 flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-outline">
                {r.label}
                {r.loading && " …"}
              </span>
              {r.routes.length > 1 && (
                <span
                  className="text-[9px] text-outline/60"
                  title={`Also reachable as ${r.routes.slice(1).join(", ")}`}
                >
                  +{r.routes.length - 1} route{r.routes.length > 2 ? "s" : ""}
                </span>
              )}
            </div>
            {r.ours.length > 0 && (
              <div className="mb-1">{r.ours.map((s) => item(r.host, s, true))}</div>
            )}
            {r.theirs.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] tracking-wider text-outline/60">
                  other sessions
                </div>
                {r.theirs.map((s) => item(r.host, s, false))}
              </>
            )}
          </div>
        );
      })}
        {total === 0 && !busy && (
          <div className="px-2 py-4 text-[11px] text-outline leading-relaxed">
            No tmux sessions running. Open a pod and one appears here — it will
            outlive the app.
          </div>
        )}
      </div>
    </>
  );
}
