import { useEffect, useState } from "react";

/**
 * Small persisted app settings. Kept outside React state so pods rendered by
 * dockview and the app chrome stay in sync without prop drilling.
 */
const KEY = "omniagent.settings.v1";

export interface Settings {
  /** Poll CPU/RAM for each pod's machine. Off = no polling at all. */
  meters: boolean;
  /**
   * Active font. Either a built-in key (`default` | `d2coding`) or a custom
   * family the user added, stored as `custom:<family name>`.
   */
  font: string;
  /** Local font families the user added by name, in the order they added them. */
  customFonts: string[];
  /**
   * Ring the focused pod once more than one is open (View → Active Pod
   * Border). Off for anyone who finds the frame noisy — the active pod's
   * header keeps its accent either way.
   */
  activePodBorder: boolean;
}

const DEFAULTS: Settings = {
  meters: true,
  font: "default",
  customFonts: [],
  activePodBorder: true,
};

/**
 * One selectable entry in View → Font. `ui` and `mono` are the family stacks
 * the choice maps onto: `ui` drives the app chrome (`--font-ui`), `mono` the
 * terminals, editor and code (`--font-mono`).
 */
export interface FontOption {
  /** Stable id stored in `font` and used as the native menu item id. */
  key: string;
  /** Label shown in the Font menu. */
  label: string;
  /** Family stack for the app chrome. */
  ui: string;
  /** Family stack for terminals, the editor and inline code. */
  mono: string;
  /** Whether the user can remove it — custom families only. */
  removable: boolean;
}

const CUSTOM_PREFIX = "custom:";

/**
 * A local family composed into a fallback chain that degrades sensibly: if the
 * family is ever missing (a different machine, a typo), it falls back through
 * the bundled fonts rather than to a proportional system font that would break
 * the terminal's fixed-width grid.
 */
function customStack(family: string): string {
  return `"${family}", "D2Coding", "JetBrains Mono", monospace`;
}

/**
 * Every selectable font: the two shipped presets first, then each local family
 * the user added. `default` keeps the historical Inter/JetBrains split;
 * `d2coding` is the bundled Hangul-friendly monospace (see the @font-face in
 * index.css); a custom entry points the whole app at a locally installed
 * family. Both presets and customs set `ui` and `mono` together, so a choice
 * really is app-wide — chrome, menus and pods alike.
 */
export function fontOptions(
  customFonts: string[] = current.customFonts,
): FontOption[] {
  const builtin: FontOption[] = [
    {
      key: "default",
      label: "Default · Inter / JetBrains Mono",
      ui: '"Inter", sans-serif',
      mono: '"JetBrains Mono", monospace',
      removable: false,
    },
    {
      key: "d2coding",
      label: "D2Coding",
      ui: '"D2Coding", "JetBrains Mono", monospace',
      mono: '"D2Coding", "JetBrains Mono", monospace',
      removable: false,
    },
  ];
  const custom: FontOption[] = customFonts.map((family) => ({
    key: CUSTOM_PREFIX + family,
    label: `${family} · local`,
    ui: customStack(family),
    mono: customStack(family),
    removable: true,
  }));
  return [...builtin, ...custom];
}

function read(): Settings {
  try {
    const s: Settings = {
      ...DEFAULTS,
      ...JSON.parse(localStorage.getItem(KEY) ?? "{}"),
    };
    // Defend against older or hand-edited storage.
    if (!Array.isArray(s.customFonts)) s.customFonts = [];
    if (typeof s.font !== "string") s.font = "default";
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

let current = read();
const listeners = new Set<(s: Settings) => void>();

/** The active option, or the default if the stored key no longer resolves. */
export function activeFont(s: Settings = current): FontOption {
  const opts = fontOptions(s.customFonts);
  return opts.find((o) => o.key === s.font) ?? opts[0];
}

/** First family in a stack, e.g. `"D2Coding"` — for FontFaceSet lookups. */
export function primaryFamily(stack: string): string {
  return stack.split(",")[0].trim();
}

/**
 * Push the active font onto the document so every CSS-driven surface — the
 * chrome, the sidebars, markdown, the window strip — updates the instant the
 * choice changes. xterm and Monaco don't read these variables, so they follow
 * through their own options (see TerminalPod / EditorPanel).
 */
export function applyFontVars(s: Settings = current) {
  if (typeof document === "undefined") return;
  const f = activeFont(s);
  const root = document.documentElement;
  root.style.setProperty("--font-ui", f.ui);
  root.style.setProperty("--font-mono", f.mono);
}

/** Snapshot for non-React callers (e.g. a pod reading the font as it opens). */
export function getSettings(): Settings {
  return current;
}

function commit(next: Settings) {
  current = next;
  localStorage.setItem(KEY, JSON.stringify(current));
  applyFontVars(current);
  for (const cb of listeners) cb(current);
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  commit({ ...current, [key]: value });
}

/** Select a font by key (built-in or `custom:<family>`). */
export function selectFont(key: string) {
  commit({ ...current, font: key });
}

/**
 * Add a locally installed family and switch the whole app to it. A no-op if
 * it's already present; callers validate availability first (isFontAvailable).
 */
export function addCustomFont(family: string) {
  const fam = family.trim();
  if (!fam) return;
  const customFonts = current.customFonts.includes(fam)
    ? current.customFonts
    : [...current.customFonts, fam];
  commit({ ...current, customFonts, font: CUSTOM_PREFIX + fam });
}

/** Remove a custom family; fall back to the default if it was the active one. */
export function removeCustomFont(family: string) {
  const customFonts = current.customFonts.filter((f) => f !== family);
  const font = current.font === CUSTOM_PREFIX + family ? "default" : current.font;
  commit({ ...current, customFonts, font });
}

/**
 * Whether a family is actually installed, by comparing the rendered width of a
 * sample against the generic fallbacks. `document.fonts.check` is unreliable
 * for system fonts that were never declared with @font-face, so measure
 * instead: if `"<family>", <generic>` renders the sample at a different width
 * than `<generic>` alone for any generic, the family took effect and is present.
 */
export function isFontAvailable(family: string): boolean {
  const fam = family.trim();
  if (!fam) return false;
  const sample = "mmMMiIloO01ABxyq한글가나다";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return true; // Can't measure — don't block the user.
  const widthOf = (stack: string) => {
    ctx.font = `72px ${stack}`;
    return ctx.measureText(sample).width;
  };
  return ["monospace", "serif", "sans-serif"].some(
    (base) => widthOf(`"${fam}", ${base}`) !== widthOf(base),
  );
}

// Apply the persisted choice before React first renders, so a D2Coding or
// custom-font user never sees a frame painted in the default family.
applyFontVars(current);

export function useSettings(): Settings {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    // Catch any change made between module init and this mount.
    setS(current);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
