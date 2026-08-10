/**
 * The lifecycle rule #16 was about: an explicit close ends the pod's tmux
 * session, a connection that merely dropped must not.
 *
 * Both cases arrive at the backend as the same `pty_kill` call — the pod
 * auto-closes after an unexpected exit and its unmount calls it — so the only
 * thing telling them apart is whether the client was still alive.
 *
 * A detached tmux client is the local twin of a dropped ssh connection: the
 * client process exits, the session keeps running. Runs against its own tmux
 * server (TMUX_TMPDIR), so the developer's sessions are never in scope.
 *
 *   npx esbuild electron/pty.ts --bundle --format=esm --platform=node \
 *     --external:node-pty --external:electron --outfile=dist-test/pty.mjs
 *   node tests/pty-session.test.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const socketDir = mkdtempSync(join(tmpdir(), "omniagent-test-"));
process.env.TMUX_TMPDIR = socketDir;

const { spawnPty, killPty, listTmuxSessions, killTmuxSession } = await import(
  "../dist-test/pty.mjs"
);

const sender = { isDestroyed: () => false, send: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exists = async (name) =>
  (await listTmuxSessions(null)).sessions.some((s) => s.name === name);

/** Poll until the session shows up — a login shell takes a moment to get there. */
async function waitFor(name) {
  for (let i = 0; i < 50; i++) {
    if (await exists(name)) return true;
    await sleep(100);
  }
  return false;
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}`);
  if (!ok) failures++;
};

async function explicitCloseEndsTheSession() {
  const name = "omniagent-test-explicit";
  spawnPty(sender, "pod-explicit", null, name, 24, 80);
  check(await waitFor(name), "explicit: session started");
  // The pod was closed by the user — the client is still alive.
  killPty("pod-explicit");
  await sleep(1500);
  check(!(await exists(name)), "explicit: session ended with the pod");
}

async function droppedConnectionKeepsTheSession() {
  const name = "omniagent-test-drop";
  spawnPty(sender, "pod-drop", null, name, 24, 80);
  check(await waitFor(name), "dropped: session started");

  // The connection dies under the pod: the client process exits, the session
  // does not. This is what a dropped ssh looks like from the app's side.
  execFileSync("tmux", ["detach-client", "-s", name], { env: process.env });
  await sleep(1000);
  check(await exists(name), "dropped: session outlived the client");

  // The pod auto-closes and its unmount calls pty_kill — the exact path that
  // used to spawn a fresh ssh and kill the session.
  killPty("pod-drop");
  await sleep(1500);
  check(await exists(name), "dropped: session survived the pod teardown");

  await killTmuxSession(null, name);
}

try {
  await explicitCloseEndsTheSession();
  await droppedConnectionKeepsTheSession();
} finally {
  try {
    execFileSync("tmux", ["kill-server"], { env: process.env, stdio: "ignore" });
  } catch {
    // No server left to kill — that is the expected end state.
  }
  rmSync(socketDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
