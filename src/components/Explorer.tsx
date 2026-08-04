import { useCallback, useEffect, useRef, useState } from "react";
import {
  DirEntry,
  fsCreateFile,
  fsDownload,
  fsHomeDir,
  fsListDir,
  fsMkdir,
  fsUpload,
} from "../ipc";

interface Props {
  host: string | null;
  onOpenFile: (path: string) => void;
  /** Reported whenever the browsed directory changes (for path resolution). */
  onCwdChange?: (cwd: string) => void;
  /** Navigate here when this changes — used by ⌘-click on a terminal path. */
  gotoPath?: { path: string; nonce: number } | null;
  /** Directory to open on mount (restored from the saved layout). */
  initialPath?: string;
}

export function Explorer({
  host,
  onOpenFile,
  onCwdChange,
  gotoPath,
  initialPath,
}: Props) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<null | "file" | "dir">(null);
  const [newName, setNewName] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await fsListDir(host, path);
        setCwd(path);
        onCwdChange?.(path);
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
    // Reopen where we left off; fall back to the home directory.
    if (initialPath) {
      load(initialPath).catch(() => fsHomeDir(host).then(load));
      return;
    }
    fsHomeDir(host)
      .then((home) => {
        if (!cancelled) load(home);
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, load]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  // External navigation request (⌘-click on a path in the terminal).
  useEffect(() => {
    if (gotoPath) load(gotoPath.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoPath?.nonce]);

  const up = () => {
    if (!cwd || cwd === "/") return;
    const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";
    load(parent);
  };

  const joinCwd = (name: string) => `${cwd?.replace(/\/$/, "")}/${name}`;

  const confirmCreate = async () => {
    const name = newName.trim();
    setCreating(null);
    setNewName("");
    if (!name || !cwd) return;
    const path = joinCwd(name);
    try {
      if (creating === "dir") {
        await fsMkdir(host, path);
      } else {
        await fsCreateFile(host, path);
      }
      await load(cwd);
      if (creating === "file") onOpenFile(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    clearTimeout(dragTimer.current);
    setDragOver(false);
    if (!cwd) return;
    const items = Array.from(e.dataTransfer.items ?? []);
    const files: File[] = [];
    for (const item of items) {
      // Skip directories — only plain files upload in v1.
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry && entry.isDirectory) continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0) return;
    setUploading(files.map((f) => f.name));
    try {
      for (const f of files) {
        const buf = await f.arrayBuffer();
        await fsUpload(host, joinCwd(f.name), buf);
      }
      await load(cwd);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading([]);
    }
  };

  const headerIcon =
    "material-symbols-outlined text-[14px] text-on-surface-variant hover:text-on-surface cursor-pointer";

  return (
    <div
      className={`w-[200px] shrink-0 border-r border-surface-container-highest bg-surface flex flex-col min-w-0 relative ${
        dragOver ? "outline outline-2 -outline-offset-2 outline-primary-container" : ""
      }`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
          // dragover fires continuously while a drag is over us; when it
          // stops (dropped elsewhere, cancelled, left the window) this
          // timer clears the overlay — dragleave alone is unreliable.
          clearTimeout(dragTimer.current);
          dragTimer.current = setTimeout(() => setDragOver(false), 400);
        }
      }}
      onDrop={onDrop}
    >
      <div className="h-6 shrink-0 bg-surface-container-low border-b border-surface-container-highest flex items-center px-2 gap-1.5">
        <span className={headerIcon} onClick={up} title="Parent directory">
          arrow_upward
        </span>
        <span
          className="text-[10px] font-medium text-on-surface-variant truncate flex-1"
          title={cwd ?? ""}
        >
          {cwd ?? "…"}
        </span>
        <span
          className={headerIcon}
          title="New file"
          onClick={() => setCreating("file")}
        >
          note_add
        </span>
        <span
          className={headerIcon}
          title="New folder"
          onClick={() => setCreating("dir")}
        >
          create_new_folder
        </span>
      </div>
      {dragOver && (
        <div className="absolute inset-0 z-10 bg-surface/80 flex flex-col items-center justify-center gap-1 pointer-events-none">
          <span className="material-symbols-outlined text-[28px] text-primary">
            upload_file
          </span>
          <span className="text-[10px] text-on-surface-variant">
            Drop to upload {host ? `to ${host}` : "here"}
          </span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-1 font-mono text-[12px] text-on-surface-variant">
        {creating && (
          <div className="flex items-center gap-1 px-1 mb-0.5">
            <span
              className={`material-symbols-outlined text-[14px] ${
                creating === "dir" ? "text-primary" : "text-tertiary"
              }`}
            >
              {creating === "dir" ? "folder" : "draft"}
            </span>
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCreate();
                if (e.key === "Escape") {
                  setCreating(null);
                  setNewName("");
                }
              }}
              onBlur={() => {
                setCreating(null);
                setNewName("");
              }}
              className="flex-1 min-w-0 bg-surface-container-high text-on-surface text-[11px] px-1 py-0.5 rounded outline-none border border-primary-container"
              placeholder={creating === "dir" ? "folder name" : "file name"}
            />
          </div>
        )}
        {downloaded && (
          <div className="px-1 mb-0.5 text-[10px] text-secondary flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">
              check_circle
            </span>
            <span className="truncate">{downloaded} → ~/Downloads</span>
          </div>
        )}
        {uploading.length > 0 && (
          <div className="px-1 mb-0.5 text-[10px] text-primary flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px] animate-spin">
              progress_activity
            </span>
            uploading {uploading.length} file{uploading.length > 1 ? "s" : ""}…
          </div>
        )}
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
              className="group flex items-center gap-1 hover:bg-surface-container-high px-1 rounded cursor-pointer mb-0.5 whitespace-nowrap"
              onClick={() =>
                e.is_dir ? load(joinCwd(e.name)) : onOpenFile(joinCwd(e.name))
              }
            >
              <span
                className={`material-symbols-outlined text-[14px] ${
                  e.is_dir ? "text-primary" : "text-tertiary"
                }`}
              >
                {e.is_dir ? "folder" : "draft"}
              </span>
              <span className="truncate flex-1">{e.name}</span>
              {!e.is_dir && (
                <span
                  className="material-symbols-outlined text-[13px] text-on-surface-variant hover:text-primary opacity-0 group-hover:opacity-100 shrink-0"
                  title="Download to ~/Downloads"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    fsDownload(host, joinCwd(e.name))
                      .then((to) => {
                        setDownloaded(to.replace(/^.*\//, ""));
                        setTimeout(() => setDownloaded(null), 2500);
                      })
                      .catch((err) => setError(String(err)));
                  }}
                >
                  download
                </span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
