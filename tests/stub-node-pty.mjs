/**
 * node-pty, replaced by a notepad. `spawnPty` is interesting here only for the
 * command line it decides on, and building the real binding needs a compiler
 * this test has no business requiring.
 */
export function spawn(file, args, options) {
  (globalThis.__ptySpawns ??= []).push({ file, args, options });
  return {
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
}
