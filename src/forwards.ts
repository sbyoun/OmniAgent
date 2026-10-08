import { useSyncExternalStore } from "react";
import { portForwardClose, portForwardOpen } from "./ipc";

/**
 * Every ssh tunnel the app has open, in one place, so the pod header can show
 * its own and the Ports panel can show them all. The backend keeps one tunnel
 * per (host, port) shared across pods; this registry remembers which pods are
 * using it, and closes it only when the last one lets go — or when the user
 * closes it outright, which drops it from every pod at once.
 */
export interface Forward {
  host: string;
  /** The port on the server, as the program printed it. */
  remote: number;
  /** Where it answers on this machine — the same number when it was free. */
  local: number;
  /** Pods that asked for it (dockview panel ids). */
  pods: string[];
}

let forwards: Forward[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const same = (f: Forward, host: string, remote: number) => f.host === host && f.remote === remote;

/** Open (or join) the tunnel to `remote` on `host` for `podId`; resolves with the local port. */
export async function openForward(host: string, remote: number, podId: string): Promise<number> {
  const local = await portForwardOpen(host, remote);
  const have = forwards.find((f) => same(f, host, remote));
  if (have) {
    if (!have.pods.includes(podId)) {
      forwards = forwards.map((f) => (f === have ? { ...f, pods: [...f.pods, podId] } : f));
      emit();
    }
    return local;
  }
  forwards = [...forwards, { host, remote, local, pods: [podId] }];
  emit();
  return local;
}

/** Close the tunnel for everyone. */
export async function closeForward(host: string, remote: number): Promise<void> {
  forwards = forwards.filter((f) => !same(f, host, remote));
  emit();
  await portForwardClose(host, remote).catch(() => {});
}

/** A pod is going away: leave its tunnels, closing the ones nobody else uses. */
export function releaseForwards(podId: string): void {
  const orphaned = forwards.filter((f) => f.pods.length === 1 && f.pods[0] === podId);
  forwards = forwards
    .filter((f) => !orphaned.includes(f))
    .map((f) => (f.pods.includes(podId) ? { ...f, pods: f.pods.filter((p) => p !== podId) } : f));
  emit();
  for (const f of orphaned) void portForwardClose(f.host, f.remote).catch(() => {});
}

export const localUrl = (f: Forward, path = "/") => `http://localhost:${f.local}${path}`;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => forwards;

/** All tunnels, newest last. Re-renders on every change. */
export function useForwards(): Forward[] {
  return useSyncExternalStore(subscribe, snapshot);
}
