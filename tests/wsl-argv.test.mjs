/**
 * What a pod is actually launched with, on each platform.
 *
 * The Windows build reaches its tmux through WSL — the local machine is the
 * distro — and that is one wrapper applied in `electron/local.ts`. The risk in
 * a change shaped like that is not that Windows comes out wrong; it is that
 * macOS and Linux quietly come out different. So the assertions below are
 * mostly about the platforms that were NOT the point: the local pod must still
 * be `$SHELL -l -c`, the remote pod must still be a bare `ssh -t`, and neither
 * may pick up a `wsl.exe` anywhere.
 *
 * `process.platform` is read once, when `local.ts` is first evaluated, so the
 * Windows half imports the bundle again under a different URL to get a second
 * evaluation with the platform swapped.
 *
 *   npx esbuild electron/pty.ts --bundle --format=esm --platform=node \
 *     --alias:node-pty=./tests/stub-node-pty.mjs --external:electron \
 *     --outfile=dist-test/pty-argv.mjs
 *   node tests/wsl-argv.test.mjs
 */
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist-test/pty-argv.mjs", import.meta.url));

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

const posix = await import(bundle);

Object.defineProperty(process, "platform", { value: "win32", configurable: true });
const win = await import(`${bundle}?win32`);
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

// ── The platforms this change was not about ───────────────────────────────

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

  const everything = [plain, owned, guest, remote];
  check(
    everything.every((c) => !JSON.stringify([c.file, c.args]).includes("wsl")),
    "posix: nothing anywhere goes near WSL",
  );
}

// ── Windows: the local machine is the distro ──────────────────────────────

{
  const owned = launch(win, { session: "sess" });
  check(owned.file === "wsl.exe", "win: local pod is launched through wsl.exe");
  check(
    owned.args.slice(0, 3).join(" ") === "-e sh -lc",
    "win: -e so wsl hands the argv over instead of reparsing it",
  );
  check(
    owned.command.includes(`cd "$HOME"`),
    "win: pod starts in the distro's home, not the /mnt/c the launcher was in",
  );
  check(
    /export TERM=xterm-256color COLORTERM=truecolor LANG LC_CTYPE="\$LANG";/.test(owned.command),
    "win: terminal and locale are exported inside the distro, where they land",
  );
  // A distro that generated only C/C.utf8/POSIX — the stock Ubuntu — must not
  // be told it is en_US.UTF-8. glibc keeps the name and drops to C collation,
  // and the shell's config dies on the first character range it evaluates.
  check(
    !owned.command.includes("en_US") &&
      owned.command.includes('case "${LANG:-}" in *[Uu][Tt][Ff]*) ;; *) LANG=C.UTF-8 ;; esac'),
    "win: keeps the distro's own UTF-8 locale, imposing one only if it has none",
  );
  check(
    owned.command.includes('-e LANG="$LANG"') &&
      owned.command.includes('-e LC_CTYPE="$LANG"'),
    "win: the resolved locale is what tmux pins on the session",
  );
  check(
    owned.command.includes("new-session -A -s 'sess'"),
    "win: local pod still attaches-or-creates its own tmux session",
  );

  const guest = launch(win, { session: "sess", owns: false });
  check(
    guest.command.includes("attach-session -t '=sess'") &&
      !guest.command.includes("new-session"),
    "win: guest pod attaches and never recreates",
  );

  const remote = launch(win, { host: "srv", session: "sess" });
  check(
    remote.file === "wsl.exe" && remote.args.slice(0, 4).join(" ") === "-e ssh -t srv",
    "win: remote pods use the distro's ssh, which is the one that has the keys",
  );

  // The whole point of routing local pods through the remote path: one command
  // string, so a fix to either is a fix to both.
  const posixRemote = launch(posix, { host: "srv", session: "sess" });
  check(
    remote.command === posixRemote.command,
    "win: a remote pod is sent the same command every other platform sends",
  );
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
