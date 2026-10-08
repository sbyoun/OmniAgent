import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { sshArgv, SSH_OPTS } from "./local";

/**
 * ssh tunnels from this machine to ports on a pod's server — what makes a
 * `localhost:8000` printed by a dev server inside a remote pod reachable from
 * the browser here, the way VS Code's Remote-SSH forwards ports.
 *
 * One tunnel per (host, remote port), shared by every pod on that host: a
 * second pod asking for the same port gets the same local port back. Each is
 * its own `ssh -N -L` process; nothing is assumed about ControlMaster. They die
 * with the app — a tunnel is not something to restore, since the server behind
 * it may be gone, and the pod asks again when it sees the URL again.
 */
interface Forward {
  proc: ChildProcess;
  local: number;
}

const forwards = new Map<string, Forward>();
const key = (host: string, remote: number) => `${host}:${remote}`;

/** The same port number when it is free here — the URL then reads the same — else any. */
function freePort(prefer: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const srv = createServer();
      srv.unref();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const { port: got } = srv.address() as { port: number };
        srv.close(() => resolve(got));
      });
    });
  return tryPort(prefer).then((p) => p ?? tryPort(0).then((q) => q ?? prefer));
}

/** Resolve true once something accepts on the port, false when ssh gave up first. */
function waitForPort(port: number, gaveUp: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      if (gaveUp()) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        setTimeout(probe, 150);
      });
    };
    probe();
  });
}

/** Open (or reuse) a tunnel to `remote` on `host`; resolves with the local port. */
export async function openForward(host: string, remote: number): Promise<number> {
  const k = key(host, remote);
  const have = forwards.get(k);
  if (have && have.proc.exitCode === null) return have.local;

  const local = await freePort(remote);
  // `-N`: no remote command, the tunnel is the whole job. `ExitOnForwardFailure`
  // turns a port that cannot be bound into an exit instead of a silent tunnel
  // to nowhere. stdin is closed outright — Windows OpenSSH never exits while
  // an inherited pipe stays open, and nothing here has anything to say to it.
  const [file, args] = sshArgv([
    ...SSH_OPTS,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-L",
    `127.0.0.1:${local}:localhost:${remote}`,
    host,
  ]);
  const proc = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  proc.stderr?.on("data", (chunk) => (stderr += chunk));
  proc.on("error", () => {});
  proc.on("exit", () => {
    if (forwards.get(k)?.proc === proc) forwards.delete(k);
  });
  forwards.set(k, { proc, local });

  const up = await waitForPort(local, () => proc.exitCode !== null, 10_000);
  if (!up) {
    proc.kill();
    forwards.delete(k);
    throw new Error(stderr.trim().split("\n").pop() || "the tunnel did not come up");
  }
  return local;
}

export function closeForward(host: string, remote: number): void {
  const k = key(host, remote);
  const have = forwards.get(k);
  if (!have) return;
  forwards.delete(k);
  have.proc.kill();
}

export function closeAllForwards(): void {
  for (const [, f] of forwards) f.proc.kill();
  forwards.clear();
}
