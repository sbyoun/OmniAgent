import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_IS_WSL, onLocalMachine, run, SSH_OPTS } from "./local";

/**
 * Where the layout lives. Both shells write the same path on purpose: the
 * webview's own storage is per-engine, so a layout saved in one build would be
 * invisible to the other even though the tmux sessions behind the pods are
 * shared.
 *
 * This one stays on the Windows side of the fence rather than in the distro,
 * unlike everything else here: it is the app's own state, not the user's work,
 * and both shells are Win32 processes reading it before a pod exists — so
 * Windows is the place they can both reach without waking WSL first.
 */
const LAYOUT_FILE = join(homedir(), ".config", "omniagent", "layout.json");

export async function readLayout(): Promise<string | null> {
  return fs.readFile(LAYOUT_FILE, "utf8").catch(() => null);
}

export async function writeLayout(content: string): Promise<void> {
  await fs.mkdir(join(homedir(), ".config", "omniagent"), { recursive: true });
  await fs.writeFile(LAYOUT_FILE, content);
}

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
  /** Identifies the box, so aliases that reach the same one can share a poll. */
  machine: string;
}

/** Quote a path for use inside a remote shell command. */
const shellQuote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

/**
 * Whether `host: null` can be answered by this process's own filesystem.
 *
 * On macOS and Linux it always can, and every local call below is the plain
 * `fs` call it has always been. On Windows it never can: the local machine is
 * the WSL distro, and `/home/you/project` is not a path Win32 can open. Those
 * take the same command path as a remote host — `ls`, `cat`, `mkdir` — with
 * wsl.exe standing in for ssh, which is why `run` accepts a null host at all.
 */
const ownFs = (host: string | null) => !host && !LOCAL_IS_WSL;

/** Pipe `data` into a command's stdin, on the host or on the local machine. */
function pipe(host: string | null, command: string, data: Buffer): Promise<void> {
  const [file, args] = host
    ? onLocalMachine("ssh", [...SSH_OPTS, host, command])
    : onLocalMachine("sh", ["-c", command]);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args);
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
  if (ownFs(host)) {
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
  const out = await run(host, `ls -1ALp ${shellQuote(path)}`, "utf8");
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
  if (ownFs(host)) return fs.readFile(path, "utf8");
  return run(host, `cat ${shellQuote(path)}`, "utf8");
}

export async function writeFile(
  host: string | null,
  path: string,
  content: string,
): Promise<void> {
  if (ownFs(host)) return fs.writeFile(path, content);
  return pipe(host, `cat > ${shellQuote(path)}`, Buffer.from(content));
}

export async function mkdir(host: string | null, path: string): Promise<void> {
  if (ownFs(host)) return fs.mkdir(path);
  await run(host, `mkdir ${shellQuote(path)}`, "utf8");
}

export async function createFile(host: string | null, path: string): Promise<void> {
  if (ownFs(host)) {
    // wx fails if the path exists, so an existing file is never truncated.
    const handle = await fs.open(path, "wx");
    await handle.close();
    return;
  }
  const q = shellQuote(path);
  await run(host, `test -e ${q} && echo EXISTS >&2 && exit 1; touch ${q}`, "utf8");
}

/** Upload raw bytes dropped onto the explorer. */
export async function upload(
  host: string | null,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const buffer = Buffer.from(data);
  if (ownFs(host)) return fs.writeFile(path, buffer);
  return pipe(host, `cat > ${shellQuote(path)}`, buffer);
}

async function readBytes(host: string | null, path: string): Promise<Buffer> {
  if (ownFs(host)) return fs.readFile(path);
  return run(host, `cat ${shellQuote(path)}`, "buffer");
}

/**
 * Copy a file into ~/Downloads (fetching it over ssh for remote pods) and
 * return the saved path. Never overwrites: collisions get ` (2)`, ` (3)`…
 *
 * The destination is deliberately the one the *desktop* calls Downloads, so on
 * Windows the file lands in `C:\Users\…\Downloads` where Explorer and the
 * browser look for it — a download nobody can find is not a download. Only the
 * fetch reaches into the distro.
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
  if (ownFs(host)) {
    try {
      const s = await fs.stat(path);
      return { exists: true, is_dir: s.isDirectory() };
    } catch {
      return { exists: false, is_dir: false };
    }
  }
  const q = shellQuote(path);
  const kind = (
    await run(
      host,
      `if [ -d ${q} ]; then echo dir; elif [ -e ${q} ]; then echo file; else echo none; fi`,
      "utf8",
    ).catch(() => "none")
  ).trim();
  return { exists: kind !== "none", is_dir: kind === "dir" };
}

/** Default working directory for a pod's explorer. */
export async function homeDir(host: string | null): Promise<string> {
  if (ownFs(host)) return homedir();
  return (await run(host, "echo $HOME", "utf8")).trim();
}

/**
 * CPU load and memory use for a pod's machine. One portable snippet covers
 * macOS (top/vm_stat) and Linux (/proc), so the same call works for local and
 * ssh pods. Used memory leaves out cached files: on macOS that is Activity
 * Monitor's "Memory Used" (app + wired + compressed), on Linux MemAvailable.
 *
 * A Windows local pod takes the Linux arm, and reports the distro's numbers —
 * which is the honest answer, since the distro is the machine whose CPU the
 * agents in that pod are burning.
 */
const STATS_SNIPPET = `ID=$(cat /etc/machine-id 2>/dev/null)
[ -z "$ID" ] && ID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
[ -z "$ID" ] && ID=$(hostname)
echo "$ID"
if [ "$(uname)" = "Darwin" ]; then
C=$(top -l 2 -n 0 -s 0 2>/dev/null | awk '/^CPU usage/{u=$3;s=$5} END{gsub("%","",u);gsub("%","",s);print u+s}')
T=$(( $(sysctl -n hw.memsize) / 1048576 ))
U=$(vm_stat | awk -F'[^0-9]+' '/page size of/{ps=$2} /^Pages active/{act=$2} /^Pages wired down/{w=$2} /^Pages purgeable/{p=$2} /^Anonymous pages/{a=$2} /^Pages occupied by compressor/{c=$2} END{if(ps==0)ps=4096; u=w+c+a-p; if(u<=0)u=w+c+act; print int(u*ps/1048576)}')
echo "$C $U $T"
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
  const out = await run(host, STATS_SNIPPET, "utf8");
  const lines = out.trim().split("\n");
  const [cpu, used, total] = (lines.pop() ?? "").trim().split(/\s+/).map(Number);
  return {
    cpu: Math.min(100, Math.max(0, cpu || 0)),
    mem_used_mb: used || 0,
    mem_total_mb: total || 0,
    machine: (lines.shift() ?? "").trim(),
  };
}
