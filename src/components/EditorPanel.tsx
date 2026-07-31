import Editor, { OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { fsReadFile, fsWriteFile } from "../ipc";

interface Props {
  host: string | null;
  path: string | null;
  onClose: () => void;
}

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

export function EditorPanel({ host, path, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const valueRef = useRef("");
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!path) return;
    setContent(null);
    setError(null);
    setSaveState("clean");
    fsReadFile(host, path)
      .then((text) => {
        valueRef.current = text;
        setContent(text);
      })
      .catch((e) => setError(String(e)));
  }, [host, path]);

  saveRef.current = async () => {
    if (!path) return;
    setSaveState("saving");
    try {
      await fsWriteFile(host, path, valueRef.current);
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "clean" : s)), 1500);
    } catch (e) {
      setError(String(e));
      setSaveState("error");
    }
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
  };

  const language = path ? guessLanguage(path) : "plaintext";

  return (
    <div className="h-1/2 shrink-0 border-b border-surface-container-highest bg-surface-container-lowest flex flex-col min-h-0">
      <div className="h-6 shrink-0 bg-surface-container-low border-b border-surface-container-highest flex items-center justify-between px-2">
        <span
          className="text-[10px] font-mono text-on-surface-variant truncate"
          title={path ?? ""}
        >
          {path ? path.split("/").pop() : "EDITOR"}
          {saveState === "dirty" && <span className="text-tertiary"> ●</span>}
          {saveState === "saving" && <span className="text-outline"> saving…</span>}
          {saveState === "saved" && (
            <span className="text-secondary"> saved</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {path && (
            <span
              className="material-symbols-outlined text-[14px] text-on-surface-variant hover:text-on-surface cursor-pointer"
              title="Save (⌘S)"
              onClick={() => saveRef.current()}
            >
              save
            </span>
          )}
          <span
            className="material-symbols-outlined text-[14px] text-on-surface-variant hover:text-error cursor-pointer"
            onClick={onClose}
          >
            close
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {!path ? (
          <div className="h-full flex flex-col items-center justify-center text-outline gap-2">
            <span className="material-symbols-outlined text-[32px]">draft</span>
            <span className="text-[11px]">Select a file from the explorer</span>
          </div>
        ) : error ? (
          <div className="p-3 text-error text-[11px] font-mono whitespace-pre-wrap select-text">
            {error}
          </div>
        ) : content === null ? (
          <div className="p-3 text-outline text-[11px] font-mono">loading…</div>
        ) : (
          <Editor
            theme="vs-dark"
            language={language}
            value={content}
            onMount={onMount}
            onChange={(v) => {
              valueRef.current = v ?? "";
              setSaveState("dirty");
            }}
            options={{
              fontSize: 13,
              fontFamily: "JetBrains Mono, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    rs: "rust",
    py: "python",
    md: "markdown",
    html: "html",
    css: "css",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    kt: "kotlin",
    swift: "swift",
  };
  return map[ext] ?? "plaintext";
}
