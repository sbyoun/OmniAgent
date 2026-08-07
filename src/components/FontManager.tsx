import { useState } from "react";
import {
  activeFont,
  addCustomFont,
  fontOptions,
  isFontAvailable,
  removeCustomFont,
  selectFont,
  useSettings,
} from "../settings";

const PREVIEW = "AaBb 0Oo1Il {}=>  한글 가나다  漢字";

/**
 * The one place to add, apply and remove app fonts, opened from View → Font →
 * "Add Local Font…". The built-ins (Default, D2Coding) can be selected but not
 * removed; a local family is added by name — validated against what is
 * actually installed — and applied app-wide the moment it is added.
 */
export function FontManager({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const [name, setName] = useState("");
  const options = fontOptions(settings.customFonts);
  const activeKey = activeFont(settings).key;

  const trimmed = name.trim();
  const duplicate = settings.customFonts.includes(trimmed);
  const available = trimmed.length > 0 ? isFontAvailable(trimmed) : null;
  const canAdd = trimmed.length > 0 && available === true && !duplicate;

  const add = () => {
    if (!canAdd) return;
    addCustomFont(trimmed);
    setName("");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] max-h-[85vh] flex flex-col bg-surface-container rounded-lg border border-surface-container-highest shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-11 shrink-0 border-b border-surface-container-highest">
          <span className="text-[13px] font-semibold tracking-wide text-on-surface">
            Font
          </span>
          <span
            className="material-symbols-outlined text-[18px] cursor-pointer text-on-surface-variant hover:text-on-surface"
            title="Close"
            onClick={onClose}
          >
            close
          </span>
        </div>

        <div className="flex-1 overflow-auto p-2">
          {options.map((o) => (
            <div
              key={o.key}
              className={`group flex items-center gap-3 px-3 py-2 rounded cursor-pointer ${
                o.key === activeKey
                  ? "bg-primary/15"
                  : "hover:bg-surface-container-high"
              }`}
              onClick={() => selectFont(o.key)}
            >
              <span
                className={`material-symbols-outlined text-[18px] shrink-0 ${
                  o.key === activeKey ? "text-primary" : "text-outline"
                }`}
              >
                {o.key === activeKey
                  ? "radio_button_checked"
                  : "radio_button_unchecked"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-on-surface truncate">
                  {o.label}
                </div>
                <div
                  className="text-[13px] text-on-surface-variant truncate leading-snug"
                  style={{ fontFamily: o.mono }}
                >
                  {PREVIEW}
                </div>
              </div>
              {o.removable && (
                <span
                  className="material-symbols-outlined text-[16px] shrink-0 text-outline opacity-0 group-hover:opacity-100 hover:text-error"
                  title="Remove this font"
                  onClick={(e) => {
                    e.stopPropagation();
                    // key is `custom:<family>` — strip the prefix back off.
                    removeCustomFont(o.key.slice("custom:".length));
                  }}
                >
                  delete
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-surface-container-highest p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">
            Add local font
          </div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              placeholder="Installed family name, e.g. Menlo, Fira Code, 나눔고딕코딩"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") onClose();
              }}
              className="flex-1 min-w-0 text-[12px] bg-surface-container-high text-on-surface rounded px-2 py-1.5 outline-none border border-surface-container-highest focus:border-primary select-text"
            />
            <button
              disabled={!canAdd}
              onClick={add}
              className="shrink-0 px-3 py-1.5 rounded text-[12px] font-medium bg-primary text-on-primary hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
          {/* Status line: availability of what's typed, or a preview of it. */}
          <div className="h-4 mt-1.5 text-[11px]">
            {trimmed.length === 0 ? (
              <span className="text-outline">
                Type the exact name of a font installed on this machine.
              </span>
            ) : duplicate ? (
              <span className="text-tertiary">Already added.</span>
            ) : available ? (
              <span className="flex items-center gap-2">
                <span className="text-secondary">✓ Found on this machine</span>
                <span
                  className="text-on-surface-variant truncate"
                  style={{ fontFamily: `"${trimmed}", monospace` }}
                >
                  {PREVIEW}
                </span>
              </span>
            ) : (
              <span className="text-error">
                Not found — check the spelling, or install the font first.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
