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
  /**
   * Where the server connects to on its side: `localhost`, or an address the
   * program printed instead — the server's own IP, a machine on its LAN.
   */
  target: string;
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
const same = (f: Forward, host: string, remote: number, target: string) =>
  f.host === host && f.remote === remote && f.target === target;

/** Open (or join) the tunnel to `remote` on `host` for `podId`; resolves with the local port. */
export async function openForward(
  host: string,
  remote: number,
  podId: string,
  target = "localhost",
): Promise<number> {
  const local = await portForwardOpen(host, remote, target);
  const have = forwards.find((f) => same(f, host, remote, target));
  if (have) {
    if (!have.pods.includes(podId)) {
      forwards = forwards.map((f) => (f === have ? { ...f, pods: [...f.pods, podId] } : f));
      emit();
    }
    return local;
  }
  forwards = [...forwards, { host, target, remote, local, pods: [podId] }];
  emit();
  return local;
}

/** Close the tunnel for everyone. */
export async function closeForward(host: string, remote: number, target = "localhost"): Promise<void> {
  forwards = forwards.filter((f) => !same(f, host, remote, target));
  emit();
  await portForwardClose(host, remote, target).catch(() => {});
}

/** A pod is going away: leave its tunnels, closing the ones nobody else uses. */
export function releaseForwards(podId: string): void {
  const orphaned = forwards.filter((f) => f.pods.length === 1 && f.pods[0] === podId);
  forwards = forwards
    .filter((f) => !orphaned.includes(f))
    .map((f) => (f.pods.includes(podId) ? { ...f, pods: f.pods.filter((p) => p !== podId) } : f));
  emit();
  for (const f of orphaned) void portForwardClose(f.host, f.remote, f.target).catch(() => {});
}

export const localUrl = (f: Forward, path = "/") => `http://localhost:${f.local}${path}`;

/** How the far end reads: `8000` for the server's own port, `10.0.0.5:8000` otherwise. */
export const farEnd = (f: Forward) =>
  f.target === "localhost" ? `${f.remote}` : `${f.target}:${f.remote}`;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => forwards;

/** All tunnels, newest last. Re-renders on every change. */
export function useForwards(): Forward[] {
  return useSyncExternalStore(subscribe, snapshot);
}
