import { useEffect, useState } from "react";

/**
 * Small persisted app settings. Kept outside React state so pods rendered by
 * dockview and the app chrome stay in sync without prop drilling.
 */
const KEY = "omniagent.settings.v1";

export interface Settings {
  /** Poll CPU/RAM for each pod's machine. Off = no polling at all. */
  meters: boolean;
}

const DEFAULTS: Settings = { meters: true };

function read(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = read();
const listeners = new Set<(s: Settings) => void>();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  current = { ...current, [key]: value };
  localStorage.setItem(KEY, JSON.stringify(current));
  for (const cb of listeners) cb(current);
}

export function useSettings(): Settings {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
