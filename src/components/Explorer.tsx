import { useCallback, useEffect, useState } from "react";
import { DirEntry, fsHomeDir, fsListDir } from "../ipc";

interface Props {
  host: string | null;
  onOpenFile: (path: string) => void;
}

export function Explorer({ host, onOpenFile }: Props) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await fsListDir(host, path);
        setCwd(path);
        setEntries(list);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    let cancelled = false;
    fsHomeDir(host)
      .then((home) => {
        if (!cancelled) load(home);
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [host, load]);

  const up = () => {
    if (!cwd || cwd === "/") return;
    const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";
    load(parent);
  };

  return (
    <div className="w-[200px] shrink-0 border-r border-surface-container-highest bg-surface flex flex-col min-w-0">
      <div className="h-6 shrink-0 bg-surface-container-low border-b border-surface-container-highest flex items-center px-2 gap-1">
        <span
          className="material-symbols-outlined text-[14px] text-on-surface-variant hover:text-on-surface cursor-pointer"
          onClick={up}
          title="Parent directory"
        >
          arrow_upward
        </span>
        <span
          className="text-[10px] font-medium text-on-surface-variant truncate"
          title={cwd ?? ""}
        >
          {cwd ?? "…"}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-1 font-mono text-[12px] text-on-surface-variant">
        {loading && <div className="px-1 text-outline">loading…</div>}
        {error && (
          <div className="px-1 text-error whitespace-pre-wrap select-text">
            {error}
          </div>
        )}
        {!loading &&
          !error &&
          entries.map((e) => (
            <div
              key={e.name}
              className="flex items-center gap-1 hover:bg-surface-container-high px-1 rounded cursor-pointer mb-0.5 whitespace-nowrap"
              onClick={() =>
                e.is_dir
                  ? load(`${cwd?.replace(/\/$/, "")}/${e.name}`)
                  : onOpenFile(`${cwd?.replace(/\/$/, "")}/${e.name}`)
              }
            >
              <span
                className={`material-symbols-outlined text-[14px] ${
                  e.is_dir ? "text-primary" : "text-tertiary"
                }`}
              >
                {e.is_dir ? "folder" : "draft"}
              </span>
              <span className="truncate">{e.name}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
