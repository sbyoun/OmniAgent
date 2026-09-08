import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, sshViaWsl } from "./local";

export interface SshHost {
  host: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
}

/**
 * The `~/.ssh/config` whose hosts this app can actually reach — the one next
 * to the `ssh` that will be run. Natively that is this user's, read straight
 * off the disk (on Windows, `C:\Users\you\.ssh\config`, which Windows' own
 * OpenSSH reads). Only when ssh is routed through WSL is it the distro's:
 * listing hosts from the other file would offer a fleet that fails to connect.
 */
async function readSshConfig(): Promise<string | null> {
  if (sshViaWsl()) return run(null, "cat ~/.ssh/config", "utf8").catch(() => null);
  try {
    return readFileSync(join(homedir(), ".ssh", "config"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse ~/.ssh/config into a list of concrete Host entries. Wildcard patterns
 * (`*`, `?`) are skipped since they are not directly connectable.
 */
export async function listSshHosts(): Promise<SshHost[]> {
  const content = await readSshConfig();
  if (content === null) return [];

  const hosts: SshHost[] = [];
  // Aliases currently collecting options (one `Host` line can declare several).
  let current: SshHost[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)[\s=]+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^=\s*/, "");

    if (key === "host") {
      current = [];
      for (const alias of value.split(/\s+/)) {
        if (/[*?]/.test(alias) || alias.startsWith("!")) continue;
        const entry: SshHost = {
          host: alias,
          hostname: null,
          user: null,
          port: null,
        };
        hosts.push(entry);
        current.push(entry);
      }
    } else if (key === "hostname") {
      for (const h of current) h.hostname = value;
    } else if (key === "user") {
      for (const h of current) h.user = value;
    } else if (key === "port") {
      const port = Number.parseInt(value, 10);
      if (Number.isFinite(port)) for (const h of current) h.port = port;
    }
  }
  return hosts;
}
