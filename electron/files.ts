import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export interface PathInfo {
  exists: boolean;
  is_dir: boolean;
}

export interface HostStats {
  cpu: number;
  mem_used_mb: number;
  mem_total_mb: number;
}

/** Quote a path for use inside a remote shell command. */
const shellQuote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Run a command on the host, resolving with stdout or rejecting with stderr. */
function ssh(host: string, command: string, encoding: "utf8"): Promise<string>;
function ssh(host: string, command: string, encoding: "buffer"): Promise<Buffer>;
function ssh(
  host: string,
  command: string,
  encoding: "utf8" | "buffer",
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      [...SSH_OPTS, host, command],
      { encoding: encoding === "buffer" ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const message = stderr?.toString().trim() || err.message;
          reject(new Error(message));
          return;
        }
        resolve(stdout as string | Buffer);
      },
    );
  });
}

/** Pipe `data` into a command's stdin on the host. */
function sshPipe(host: string, command: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTS, host, command]);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)),
    );
    child.stdin.end(data);
  });
}

const sortEntries = (entries: DirEntry[]) =>
  entries.sort(
    (a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name),
  );

/**
 * On-demand directory listing: local fs when `host` is null, otherwise a
 * one-shot `ssh <host> ls` — connect only when the explorer opens.
 */
export async function listDir(host: string | null, path: string): Promise<DirEntry[]> {
  if (!host) {
    const names = await fs.readdir(path);
    const entries = await Promise.all(
      names.map(async (name) => ({
        name,
        // stat() follows symlinks, so a linked directory counts as a
        // directory (lstat would call it a file).
        is_dir: await fs
          .stat(join(path, name))
          .then((s) => s.isDirectory())
          .catch(() => false),
      })),
    );
    return sortEntries(entries);
  }
  // -L dereferences symlinks so linked directories get the `/` marker from -p.
  const out = await ssh(host, `ls -1ALp ${shellQuote(path)}`, "utf8");
  return sortEntries(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        name: line.replace(/\/$/, ""),
        is_dir: line.endsWith("/"),
      })),
  );
}

export async function readFile(host: string | null, path: string): Promise<string> {
  if (!host) return fs.readFile(path, "utf8");
  return ssh(host, `cat ${shellQuote(path)}`, "utf8");
}

export async function writeFile(
  host: string | null,
  path: string,
  content: string,
): Promise<void> {
  if (!host) return fs.writeFile(path, content);
  return sshPipe(host, `cat > ${shellQuote(path)}`, Buffer.from(content));
}

export async function mkdir(host: string | null, path: string): Promise<void> {
  if (!host) return fs.mkdir(path);
  await ssh(host, `mkdir ${shellQuote(path)}`, "utf8");
}

export async function createFile(host: string | null, path: string): Promise<void> {
  if (!host) {
    // wx fails if the path exists, so an existing file is never truncated.
    const handle = await fs.open(path, "wx");
    await handle.close();
    return;
  }
  const q = shellQuote(path);
  await ssh(host, `test -e ${q} && echo EXISTS >&2 && exit 1; touch ${q}`, "utf8");
}

/** Upload raw bytes dropped onto the explorer. */
export async function upload(
  host: string | null,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const buffer = Buffer.from(data);
  if (!host) return fs.writeFile(path, buffer);
  return sshPipe(host, `cat > ${shellQuote(path)}`, buffer);
}

async function readBytes(host: string | null, path: string): Promise<Buffer> {
  if (!host) return fs.readFile(path);
  return ssh(host, `cat ${shellQuote(path)}`, "buffer");
}

/**
 * Copy a file into ~/Downloads (fetching it over ssh for remote pods) and
 * return the saved path. Never overwrites: collisions get ` (2)`, ` (3)`…
 */
export async function download(host: string | null, path: string): Promise<string> {
  const dir = join(homedir(), "Downloads");
  await fs.mkdir(dir, { recursive: true });

  const name = path.split("/").filter(Boolean).pop() ?? "download";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let target = join(dir, name);
  for (let n = 2; ; n++) {
    try {
      await fs.access(target);
    } catch {
      break;
    }
    target = join(dir, `${stem} (${n})${ext}`);
  }

  await fs.writeFile(target, await readBytes(host, path));
  return target;
}

/**
 * Read a file as base64 — used by the image viewer, which needs raw bytes and
 * must work for remote pods, where the file lives over ssh.
 */
export async function readBase64(host: string | null, path: string): Promise<string> {
  const bytes = await readBytes(host, path);
  const MAX = 25 * 1024 * 1024;
  if (bytes.length > MAX) {
    throw new Error(
      `file too large to preview (${Math.round(bytes.length / 1_048_576)} MB)`,
    );
  }
  return bytes.toString("base64");
}

/**
 * Does this path exist, and is it a directory? Decides whether a path clicked
 * in the terminal opens in the explorer or the editor.
 */
export async function stat(host: string | null, path: string): Promise<PathInfo> {
  if (!host) {
    try {
      const s = await fs.stat(path);
      return { exists: true, is_dir: s.isDirectory() };
    } catch {
      return { exists: false, is_dir: false };
    }
  }
  const q = shellQuote(path);
  const kind = (
    await ssh(
      host,
      `if [ -d ${q} ]; then echo dir; elif [ -e ${q} ]; then echo file; else echo none; fi`,
      "utf8",
    ).catch(() => "none")
  ).trim();
  return { exists: kind !== "none", is_dir: kind === "dir" };
}

/** Default working directory for a pod's explorer. */
export async function homeDir(host: string | null): Promise<string> {
  if (!host) return homedir();
  return (await ssh(host, "echo $HOME", "utf8")).trim();
}

/**
 * CPU load and memory use for a pod's machine. One portable snippet covers
 * macOS (top/vm_stat) and Linux (/proc), so the same call works for local and
 * ssh pods.
 */
const STATS_SNIPPET = `if [ "$(uname)" = "Darwin" ]; then
C=$(top -l 2 -n 0 -s 0 2>/dev/null | awk '/^CPU usage/{u=$3;s=$5} END{gsub("%","",u);gsub("%","",s);print u+s}')
T=$(( $(sysctl -n hw.memsize) / 1048576 ))
F=$(vm_stat | awk '/Pages free|Pages inactive|Pages speculative/{gsub("\\.","",$NF); s+=$NF} END{print int(s*4096/1048576)}')
echo "$C $((T-F)) $T"
else
read _ a b c d e f g rest < /proc/stat; i1=$((d+e)); t1=$((a+b+c+d+e+f+g))
sleep 0.25
read _ a b c d e f g rest < /proc/stat; i2=$((d+e)); t2=$((a+b+c+d+e+f+g))
C=$(awk -v i1=$i1 -v t1=$t1 -v i2=$i2 -v t2=$t2 'BEGIN{d=t2-t1; if(d<=0){print 0}else{printf "%.1f", 100*(1-(i2-i1)/d)}}')
MT=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
MA=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
echo "$C $((MT-MA)) $MT"
fi`;

export async function hostStats(host: string | null): Promise<HostStats> {
  const out = host
    ? await ssh(host, STATS_SNIPPET, "utf8")
    : await new Promise<string>((resolve, reject) =>
        execFile("sh", ["-c", STATS_SNIPPET], (err, stdout, stderr) =>
          err ? reject(new Error(stderr || err.message)) : resolve(stdout),
        ),
      );
  const line = out.trim().split("\n").pop() ?? "";
  const [cpu, used, total] = line.trim().split(/\s+/).map(Number);
  return {
    cpu: Math.min(100, Math.max(0, cpu || 0)),
    mem_used_mb: used || 0,
    mem_total_mb: total || 0,
  };
}
