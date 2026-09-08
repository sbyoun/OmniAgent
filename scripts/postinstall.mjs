/**
 * node-pty's macOS prebuilds carry a `spawn-helper`, and it comes out of the
 * npm tarball as `-rw-r--r--` — without the executable bit, every local pod
 * fails to open its pty. Restore it.
 *
 * This used to be a one-line `chmod … 2>/dev/null || true` in package.json,
 * which npm hands to `cmd.exe` on Windows: no `chmod`, no `/dev/null`, and no
 * `true` to swallow the failure, so `npm ci` died on its very last step with
 * everything already correctly installed. Hence a script — it can simply know
 * that Windows has neither the helper (its prebuild is ConPTY) nor the
 * permission bit, and do nothing.
 *
 * Best-effort throughout, exactly as the shell version was: a missing
 * prebuilds directory means npm resolved a different platform, or built from
 * source, and neither is this script's business.
 */
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "win32") {
  const prebuilds = "node_modules/node-pty/prebuilds";
  let dirs = [];
  try {
    dirs = readdirSync(prebuilds);
  } catch {
    // No prebuilds at all — nothing to fix up.
  }
  for (const dir of dirs) {
    try {
      chmodSync(join(prebuilds, dir, "spawn-helper"), 0o755);
    } catch {
      // This platform's prebuild has no helper. Only macOS ships one.
    }
  }
}
