import Editor, { OnMount } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { fsDownload, fsReadBase64, fsReadFile, fsWriteFile } from "../ipc";
import { activeFont, primaryFamily, useSettings } from "../settings";

interface Props {
  host: string | null;
  path: string | null;
  onClose: () => void;
  /** Set by the pod's splitter and remembered with the layout. */
  height: number;
}

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

export function EditorPanel({ host, path, onClose, height }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [pdfSrc, setPdfSrc] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const valueRef = useRef("");
  const saveRef = useRef<() => void>(() => {});
  const previewRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const settings = useSettings();
  const editorFont = activeFont(settings).mono;

  useEffect(() => {
    return () => {
      if (pdfSrc) URL.revokeObjectURL(pdfSrc);
    };
  }, [pdfSrc]);

  const isMarkdown = !!path && /\.(md|markdown|mdx)$/i.test(path);
  const imageType = path ? imageMime(path) : null;
  const isPdf = !!path && /\.pdf$/i.test(path);
  /** Nothing here can be edited or saved — the same as an image. */
  const readOnly = !!imageType || isPdf;

  useEffect(() => {
    if (!path) return;
    setContent(null);
    setImageSrc(null);
    setPdfSrc((old) => {
      // Object URLs hold the bytes until they are let go.
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setError(null);
    setSaveState("clean");
    const mime = imageMime(path);
    if (mime) {
      // Images are fetched as base64 and shown inline instead of as text.
      fsReadBase64(host, path)
        .then((b64) => setImageSrc(`data:${mime};base64,${b64}`))
        .catch((e) => setError(String(e)));
      return;
    }
    if (/\.pdf$/i.test(path)) {
      // The viewer built into the webview does the rendering; it just needs a
      // URL it will accept, and a data: URI is not one.
      fsReadBase64(host, path)
        .then((b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          setPdfSrc(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
        })
        .catch((e) => setError(String(e)));
      return;
    }
    // Markdown opens in preview; code opens in the editor.
    setPreview(/\.(md|markdown|mdx)$/i.test(path));
    fsReadFile(host, path)
      .then((text) => {
        valueRef.current = text;
        setContent(text);
      })
      .catch((e) => setError(String(e)));
  }, [host, path]);

  const previewHtml = useMemo(() => {
    if (!preview || content === null) return "";
    return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  }, [preview, content]);

  /**
   * In preview mode copy what the user SEES: rich text (HTML flavor) plus a
   * readable plain-text fallback. In source mode copy the raw file. Feedback
   * is optimistic — the clipboard write is not awaited before showing ✓, so
   * large files don't feel laggy.
   */
  const copyAll = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    const done = (p: Promise<unknown>) => p.catch((e) => setError(String(e)));
    if (preview && previewRef.current) {
      const html = previewRef.current.innerHTML;
      const text = previewRef.current.innerText;
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        done(
          navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ]),
        );
      } else {
        done(navigator.clipboard.writeText(text));
      }
      return;
    }
    done(navigator.clipboard.writeText(valueRef.current));
  };

  const download = async () => {
    if (!path) return;
    try {
      const to = await fsDownload(host, path);
      setSaved(to.replace(/^.*\/Downloads\//, "~/Downloads/"));
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError(String(e));
    }
  };

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
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
  };

  // Monaco caches glyph widths, so a font change (View → Font) needs an
  // explicit remeasure once the new family is actually loaded — otherwise the
  // caret and the text sit on different metrics until the next relayout.
  useEffect(() => {
    document.fonts
      .load(`13px ${primaryFamily(editorFont)}`)
      .catch(() => {})
      .then(() => monacoRef.current?.editor.remeasureFonts());
  }, [editorFont]);

  const language = path ? guessLanguage(path) : "plaintext";

  return (
    <div
      style={{ height }}
      className="shrink-0 border-b border-surface-container-highest bg-surface-container-lowest flex flex-col min-h-0"
    >
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
        <div className="flex items-center gap-2 shrink-0">
          {saved && (
            <span className="text-[10px] text-secondary truncate max-w-[160px]">
              saved to {saved}
            </span>
          )}
          {path && isMarkdown && !readOnly && (
            <span
              className={`material-symbols-outlined text-[14px] cursor-pointer ${
                preview
                  ? "text-primary"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
              title={preview ? "Edit source" : "Preview markdown"}
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? "code" : "visibility"}
            </span>
          )}
          {path && !readOnly && (
            <span
              className={`material-symbols-outlined text-[14px] cursor-pointer ${
                copied
                  ? "text-secondary"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
              title="Copy entire file"
              onClick={copyAll}
            >
              {copied ? "check" : "content_copy"}
            </span>
          )}
          {path && (
            <span
              className="material-symbols-outlined text-[14px] text-on-surface-variant hover:text-on-surface cursor-pointer"
              title="Download to ~/Downloads"
              onClick={download}
            >
              download
            </span>
          )}
          {path && !preview && !readOnly && (
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
        ) : isPdf ? (
          pdfSrc ? (
            <embed
              src={pdfSrc}
              type="application/pdf"
              className="w-full h-full bg-surface-container-lowest"
            />
          ) : (
            <div className="p-3 text-outline text-[11px] font-mono">loading…</div>
          )
        ) : imageType ? (
          imageSrc ? (
            <div className="h-full overflow-auto bg-surface-container-lowest flex items-center justify-center p-3">
              <img
                src={imageSrc}
                alt={path ?? ""}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : (
            <div className="p-3 text-outline text-[11px] font-mono">loading…</div>
          )
        ) : content === null ? (
          <div className="p-3 text-outline text-[11px] font-mono">loading…</div>
        ) : preview ? (
          <div
            ref={previewRef}
            className="markdown-preview h-full overflow-auto px-4 py-3 select-text"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
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
              fontFamily: editorFont,
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

/** MIME type for previewable images, or null for everything else. */
function imageMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    avif: "image/avif",
  };
  return map[ext] ?? null;
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
