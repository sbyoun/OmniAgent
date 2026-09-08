/**
 * What a pod is actually launched with, on each platform and in each of the
 * places "local" can be.
 *
 * `electron/local.ts` decides that once per process: `posix` off Windows, and
 * on Windows either `wsl` (a distro is the local machine, pods ride wsl.exe to
 * its tmux) or `native` (no distro; the pod is PowerShell and there is no tmux
 * to attach to). ssh is native by default on every platform and only goes
 * through the distro when `OMNIAGENT_SSH=wsl` asks for it.
 *
 * The risk in a change shaped like that is not that Windows comes out wrong;
 * it is that macOS and Linux quietly come out different. So the first block is
 * about the platform that was NOT the point: the local pod must still be
 * `$SHELL -l -c`, the remote pod must still be a bare `ssh -t`, and neither may
 * pick up a `wsl.exe` anywhere.
 *
 * `local.ts` reads `process.platform` and its environment once, when first
 * evaluated, so each variant imports the bundle again under a different URL to
 * get a fresh evaluation with the platform and mode swapped. The mode is
 * forced through `OMNIAGENT_LOCAL`, which exists for exactly this: the test
 * runs on machines with no wsl.exe to detect against.
 *
 *   npx esbuild electron/pty.ts --bundle --format=esm --platform=node \
 *     --alias:node-pty=./tests/stub-node-pty.mjs --external:electron \
 *     --outfile=dist-test/pty-argv.mjs
 *   node tests/wsl-argv.test.mjs
 */

// Kept as a URL, not a path: on Windows `import("C:\\…")` is rejected by the
// ESM loader (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, protocol 'c:'), and a URL is
// what the `?variant` suffixes below were always meant to be appended to.
const bundle = new URL("../dist-test/pty-argv.mjs", import.meta.url).href;

const sender = { isDestroyed: () => false, send: () => {} };

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}`);
  if (!ok) failures++;
};

/** Spawn a pod and hand back the command line it chose. */
function launch(mod, { host = null, session = null, owns = true } = {}) {
  globalThis.__ptySpawns = [];
  mod.spawnPty(sender, "pod", host, session, 24, 80, owns);
  const [call] = globalThis.__ptySpawns;
  return { file: call.file, args: call.args, command: call.args.at(-1) };
}

/**
 * One evaluation of the bundle under a given platform and environment. Every
 * knob is restored afterwards so the variants cannot leak into each other.
 */
async function variant(name, platform, env = {}) {
  const realPlatform = process.platform;
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`${bundle}?${name}`);
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const noKnobs = { OMNIAGENT_LOCAL: undefined, OMNIAGENT_WSL_DISTRO: undefined, OMNIAGENT_SSH: undefined };

const posix = await variant("linux", "linux", noKnobs);
const wsl = await variant("wsl", "win32", { ...noKnobs, OMNIAGENT_LOCAL: "wsl" });
const wslSsh = await variant("wslssh", "win32", { ...noKnobs, OMNIAGENT_LOCAL: "wsl", OMNIAGENT_SSH: "wsl" });
const native = await variant("native", "win32", { ...noKnobs, OMNIAGENT_LOCAL: "native" });
const detected = await variant("detected", "win32", noKnobs);

const touchesWsl = (c) => JSON.stringify([c.file, c.args]).includes("wsl");

// ── The platform this change was not about ────────────────────────────────

{
  const shell = process.env.SHELL || "/bin/zsh";

  const plain = launch(posix);
  check(plain.file === shell && plain.args.join(" ") === "-l", "posix: bare pod is $SHELL -l");

  const owned = launch(posix, { session: "sess" });
  check(owned.file === shell, "posix: pod runs the user's own shell");
  check(
    owned.args[0] === "-l" && owned.args[1] === "-c" && owned.args.length === 3,
    "posix: pod is a login shell running one command",
  );
  check(
    owned.command.startsWith("command -v tmux >/dev/null 2>&1 && {"),
    "posix: pod still probes for tmux before using it",
  );
  check(
    owned.command.endsWith(`|| exec "${shell}" -l`),
    "posix: pod still falls back to the user's shell by name",
  );

  const guest = launch(posix, { session: "sess", owns: false });
  check(
    guest.command.startsWith("tmux -u attach-session -t '=sess' ||"),
    "posix: guest pod attaches and nothing more",
  );

  const remote = launch(posix, { host: "srv", session: "sess" });
  check(
    remote.file === "ssh" && remote.args[0] === "-t" && remote.args[1] === "srv",
    "posix: remote pod is a bare ssh -t",
  );

  check(
    ![plain, owned, guest, remote].some(touchesWsl),
    "posix: nothing anywhere goes near WSL",
  );
}

// ── Windows, a distro installed: the local machine is the distro ──────────

{
  const owned = launch(wsl, { session: "sess" });
  check(owned.file === "wsl.exe", "wsl: local pod is launched through wsl.exe");
  check(
    owned.args.slice(0, 3).join(" ") === "-e sh -lc",
    "wsl: -e so wsl hands the argv over instead of reparsing it",
  );
  check(
    owned.command.includes(`cd "$HOME"`),
    "wsl: pod starts in the distro's home, not the /mnt/c the launcher was in",
  );
  check(
    /export TERM=xterm-256color COLORTERM=truecolor LANG LC_CTYPE="\$LANG";/.test(owned.command),
    "wsl: terminal and locale are exported inside the distro, where they land",
  );
  // A distro that generated only C/C.utf8/POSIX — the stock Ubuntu — must not
  // be told it is en_US.UTF-8. glibc keeps the name and drops to C collation,
  // and the shell's config dies on the first character range it evaluates.
  check(
    !owned.command.includes("en_US") &&
      owned.command.includes('case "${LANG:-}" in *[Uu][Tt][Ff]*) ;; *) LANG=C.UTF-8 ;; esac'),
    "wsl: keeps the distro's own UTF-8 locale, imposing one only if it has none",
  );
  check(
    owned.command.includes('-e LANG="$LANG"') && owned.command.includes('-e LC_CTYPE="$LANG"'),
    "wsl: the resolved locale is what tmux pins on the session",
  );
  check(
    owned.command.includes("new-session -A -s 'sess'"),
    "wsl: local pod still attaches-or-creates its own tmux session",
  );

  const guest = launch(wsl, { session: "sess", owns: false });
  check(
    guest.command.includes("attach-session -t '=sess'") && !guest.command.includes("new-session"),
    "wsl: guest pod attaches and never recreates",
  );

  // ssh is Windows' own by default: it is the one that reads the user's
  // C:\Users\…\.ssh\config, and the tmux it reaches runs on the server. Named
  // with its extension — node-pty does not add `.exe` the way a shell would,
  // and a bare `ssh` failed to spawn with "File not found".
  const remote = launch(wsl, { host: "srv", session: "sess" });
  check(
    remote.file === "ssh.exe" && remote.args.slice(0, 2).join(" ") === "-t srv",
    "wsl: remote pod is native ssh.exe -t, not the distro's",
  );

  // The whole point of routing local pods through the remote path: one command
  // string, so a fix to either is a fix to both.
  const posixRemote = launch(posix, { host: "srv", session: "sess" });
  check(
    remote.command === posixRemote.command,
    "wsl: a remote pod is sent the same command every other platform sends",
  );

  // …and for anyone whose keys live in the distro, OMNIAGENT_SSH=wsl.
  const viaDistro = launch(wslSsh, { host: "srv", session: "sess" });
  check(
    viaDistro.file === "wsl.exe" && viaDistro.args.slice(0, 4).join(" ") === "-e ssh -t srv",
    "wsl: OMNIAGENT_SSH=wsl routes ssh through the distro instead",
  );
}

// ── Windows, no distro: PowerShell pods, native everything ────────────────

{
  const plain = launch(native);
  check(
    /^(pwsh|powershell)\.exe$/.test(plain.file) && plain.args.join(" ") === "-NoLogo",
    "native: bare pod is PowerShell",
  );

  // A session name is still handed down (the layout carries one), but there is
  // nothing to attach it to, so the pod is the same plain shell.
  const owned = launch(native, { session: "sess" });
  check(
    owned.file === plain.file && owned.args.join(" ") === "-NoLogo",
    "native: a session name changes nothing — there is no tmux to restore from",
  );

  const guest = launch(native, { session: "sess", owns: false });
  check(
    guest.file === plain.file &&
      guest.args.includes("-Command") &&
      guest.command.includes("tmux session sess is gone") &&
      guest.command.includes("exit 1"),
    "native: guest pod says the session is gone and exits, as attachOnly does",
  );

  const remote = launch(native, { host: "srv", session: "sess" });
  check(
    remote.file === "ssh.exe" && remote.args.slice(0, 2).join(" ") === "-t srv",
    "native: remote pod is native ssh.exe -t",
  );
  check(
    remote.command === launch(posix, { host: "srv", session: "sess" }).command,
    "native: remote pod gets the same command every other platform sends",
  );

  check(
    ![plain, owned, guest, remote].some(touchesWsl),
    "native: nothing anywhere goes near WSL",
  );

  // The tmux helpers answer for a native local machine without spawning.
  const sessions = await native.listTmuxSessions(null);
  check(
    Array.isArray(sessions.sessions) && sessions.sessions.length === 0 && sessions.machine.length > 0,
    "native: local tmux sessions are none, on a machine with a name",
  );
  check((await native.tmuxSessionStarted(null, "sess")) === null, "native: no session start time");
  check((await native.renameTmuxSession(null, "a", "b")) === false, "native: rename is refused");
}

// ── Windows, nothing forced: starts native until detection says otherwise ─

{
  const plain = launch(detected);
  check(
    /^(pwsh|powershell)\.exe$/.test(plain.file),
    "detected: with no knobs set the synchronous default is native",
  );
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
