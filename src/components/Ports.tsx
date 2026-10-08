import { openExternal } from "../ipc";
import { closeForward, farEnd, localUrl, useForwards } from "../forwards";

/**
 * Every ssh tunnel the app has open, across all pods — the place to see what
 * is reachable and to close it. A tunnel is per (host, port); the pods using
 * it are listed under it. Closing one here closes it for all of them.
 */
export function Ports() {
  const forwards = useForwards();
  const hosts = Array.from(new Set(forwards.map((f) => f.host)));

  return (
    <>
      <div className="h-8 shrink-0 flex items-center px-3 border-b border-surface-container-highest">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant">
          Forwarded ports
        </span>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {forwards.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-outline leading-relaxed">
            No tunnels open. When a server in a remote pod prints a{" "}
            <span className="font-mono">localhost:</span> address, the pod offers to open it
            here; ⌘-clicking the address does the same.
          </div>
        )}
        {hosts.map((host) => (
          <div key={host} className="mb-1">
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant truncate">
              {host}
            </div>
            {forwards
              .filter((f) => f.host === host)
              .map((f) => (
                <div
                  key={`${f.target}:${f.remote}`}
                  className="flex items-center gap-2 px-3 py-1 rounded hover:bg-surface-container-high group"
                >
                  <span className="material-symbols-outlined text-[14px] text-secondary shrink-0">
                    swap_horiz
                  </span>
                  <button
                    onClick={() => void openExternal(localUrl(f))}
                    title={`Open http://localhost:${f.local}/ in your browser`}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="text-[11px] font-mono text-on-surface truncate">
                      {farEnd(f)}
                      {(f.local !== f.remote || f.target !== "localhost") && (
                        <span className="text-on-surface-variant"> → localhost:{f.local}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-outline truncate">
                      {f.pods.map((p) => p.replace(/^pod-/, "pod ")).join(", ")}
                    </div>
                  </button>
                  <span
                    className="material-symbols-outlined text-[14px] cursor-pointer text-on-surface-variant opacity-0 group-hover:opacity-100 hover:text-error"
                    title="Close the tunnel"
                    onClick={() => void closeForward(f.host, f.remote, f.target)}
                  >
                    close
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}
