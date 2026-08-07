use serde::Serialize;
use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Quote a path for use inside a remote shell command.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

fn ssh_base(host: &str) -> Command {
    let mut c = Command::new("ssh");
    c.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host]);
    c
}

/// On-demand directory listing: local fs when `host` is None, otherwise a
/// one-shot `ssh <host> ls` (SDD 3.3 — connect only when the explorer opens).
#[tauri::command]
pub async fn fs_list_dir(host: Option<String>, path: String) -> Result<Vec<DirEntry>, String> {
    match host {
        None => {
            let mut out = Vec::new();
            let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
            for e in entries.flatten() {
                // metadata() follows symlinks, so a linked directory counts
                // as a directory (file_type() would call it a file).
                let is_dir = std::fs::metadata(e.path())
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                out.push(DirEntry {
                    name: e.file_name().to_string_lossy().to_string(),
                    is_dir,
                });
            }
            sort_entries(&mut out);
            Ok(out)
        }
        Some(h) => {
            // -L dereferences symlinks so linked directories get the `/`
            // marker from -p too.
            let output = ssh_base(&h)
                .arg(format!("ls -1ALp {}", shell_quote(&path)))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            let mut out: Vec<DirEntry> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| DirEntry {
                    name: l.trim_end_matches('/').to_string(),
                    is_dir: l.ends_with('/'),
                })
                .collect();
            sort_entries(&mut out);
            Ok(out)
        }
    }
}

fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
}

#[tauri::command]
pub async fn fs_read_file(host: Option<String>, path: String) -> Result<String, String> {
    match host {
        None => std::fs::read_to_string(&path).map_err(|e| e.to_string()),
        Some(h) => {
            let output = ssh_base(&h)
                .arg(format!("cat {}", shell_quote(&path)))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
    }
}

#[tauri::command]
pub async fn fs_write_file(host: Option<String>, path: String, content: String) -> Result<(), String> {
    match host {
        None => std::fs::write(&path, content).map_err(|e| e.to_string()),
        Some(h) => {
            let mut child = ssh_base(&h)
                .arg(format!("cat > {}", shell_quote(&path)))
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            child
                .stdin
                .take()
                .ok_or("no stdin")?
                .write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn fs_mkdir(host: Option<String>, path: String) -> Result<(), String> {
    match host {
        None => std::fs::create_dir(&path).map_err(|e| e.to_string()),
        Some(h) => {
            let output = ssh_base(&h)
                .arg(format!("mkdir {}", shell_quote(&path)))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn fs_create_file(host: Option<String>, path: String) -> Result<(), String> {
    match host {
        None => {
            if std::path::Path::new(&path).exists() {
                return Err("already exists".into());
            }
            std::fs::write(&path, "").map_err(|e| e.to_string())
        }
        Some(h) => {
            let q = shell_quote(&path);
            let output = ssh_base(&h)
                .arg(format!(
                    "test -e {q} && echo EXISTS >&2 && exit 1; touch {q}"
                ))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(())
        }
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Upload raw file bytes dropped onto the explorer. Metadata travels in
/// headers (`x-host`, percent-encoded `x-path`) so the body stays a plain
/// binary payload.
#[tauri::command]
pub async fn fs_upload(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let headers = request.headers();
    let host = headers
        .get("x-host")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let path = headers
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing x-path header")?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("expected raw body".into()),
    };
    match host {
        None => std::fs::write(&path, data).map_err(|e| e.to_string()),
        Some(h) => {
            let mut child = ssh_base(&h)
                .arg(format!("cat > {}", shell_quote(&path)))
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            child
                .stdin
                .take()
                .ok_or("no stdin")?
                .write_all(data)
                .map_err(|e| e.to_string())?;
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(())
        }
    }
}

/// Copy a file into ~/Downloads (fetching it over ssh for remote pods).
/// Returns the saved path. Never overwrites: collisions get ` (2)`, ` (3)`…
#[tauri::command]
pub async fn fs_download(host: Option<String>, path: String) -> Result<String, String> {
    let dir = dirs::home_dir().ok_or("no home dir")?.join("Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = path.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("download");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut target = dir.join(name);
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }

    match host {
        None => {
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
        Some(h) => {
            let output = ssh_base(&h)
                .arg(format!("cat {}", shell_quote(&path)))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            std::fs::write(&target, &output.stdout).map_err(|e| e.to_string())?;
        }
    }
    Ok(target.to_string_lossy().to_string())
}

/// Read a file as base64 — used by the image viewer, which needs raw bytes
/// (and must work for remote pods, where the file lives over ssh).
#[tauri::command]
pub async fn fs_read_base64(host: Option<String>, path: String) -> Result<String, String> {
    let bytes: Vec<u8> = match host {
        None => std::fs::read(&path).map_err(|e| e.to_string())?,
        Some(h) => {
            let output = ssh_base(&h)
                .arg(format!("cat {}", shell_quote(&path)))
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            output.stdout
        }
    };
    const MAX: usize = 25 * 1024 * 1024;
    if bytes.len() > MAX {
        return Err(format!("file too large to preview ({} MB)", bytes.len() / 1_048_576));
    }
    Ok(base64_encode(&bytes))
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[derive(Serialize, Clone)]
pub struct HostStats {
    pub cpu: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    /// Identifies the box, so aliases that reach the same one share a poll.
    pub machine: String,
}

/// CPU load and memory use for a pod's machine. One portable snippet covers
/// macOS (top/vm_stat) and Linux (/proc), so the same call works for local
/// and ssh pods. Used memory leaves out cached files: on macOS that is
/// Activity Monitor's "Memory Used" (app + wired + compressed), on Linux
/// MemAvailable.
const STATS_SNIPPET: &str = r#"ID=$(cat /etc/machine-id 2>/dev/null)
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
fi"#;

#[tauri::command]
pub async fn host_stats(host: Option<String>) -> Result<HostStats, String> {
    let out = match host {
        None => Command::new("sh")
            .arg("-c")
            .arg(STATS_SNIPPET)
            .output()
            .map_err(|e| e.to_string())?,
        Some(h) => ssh_base(&h)
            .arg(STATS_SNIPPET)
            .output()
            .map_err(|e| e.to_string())?,
    };
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let machine = text.lines().next().unwrap_or("").trim().to_string();
    let line = text.lines().last().unwrap_or("").trim();
    let mut it = line.split_whitespace();
    let cpu: f32 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let used: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let total: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(HostStats {
        cpu: cpu.clamp(0.0, 100.0),
        mem_used_mb: used,
        mem_total_mb: total,
        machine,
    })
}

#[derive(Serialize, Clone)]
pub struct PathInfo {
    pub exists: bool,
    pub is_dir: bool,
}

/// Does this path exist, and is it a directory? Used to decide whether a
/// path clicked in the terminal opens in the explorer or the editor.
#[tauri::command]
pub async fn fs_stat(host: Option<String>, path: String) -> Result<PathInfo, String> {
    match host {
        None => match std::fs::metadata(&path) {
            Ok(m) => Ok(PathInfo {
                exists: true,
                is_dir: m.is_dir(),
            }),
            Err(_) => Ok(PathInfo {
                exists: false,
                is_dir: false,
            }),
        },
        Some(h) => {
            let q = shell_quote(&path);
            let output = ssh_base(&h)
                .arg(format!("if [ -d {q} ]; then echo dir; elif [ -e {q} ]; then echo file; else echo none; fi"))
                .output()
                .map_err(|e| e.to_string())?;
            let kind = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(PathInfo {
                exists: kind != "none",
                is_dir: kind == "dir",
            })
        }
    }
}

/// Default working directory for a pod's explorer: $HOME locally, `~` resolved
/// remotely.
#[tauri::command]
pub async fn fs_home_dir(host: Option<String>) -> Result<String, String> {
    match host {
        None => dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or_else(|| "no home dir".into()),
        Some(h) => {
            let output = ssh_base(&h)
                .arg("echo $HOME")
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
    }
}

/// Where the layout lives. Both shells write the same path on purpose: the
/// webview's own storage is per-engine, so a layout saved in one build would
/// be invisible to the other even though the tmux sessions behind the pods
/// are shared.
fn layout_file() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("omniagent").join("layout.json"))
}

#[tauri::command]
pub async fn layout_read() -> Option<String> {
    std::fs::read_to_string(layout_file()?).ok()
}

#[tauri::command]
pub async fn layout_write(content: String) -> Result<(), String> {
    let path = layout_file().ok_or("no home dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Open a link in the user's browser. Nothing may navigate the app's own
/// webview: the page there is the app, and it is the only page trusted with
/// the command surface.
#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url, None::<&str>);
    }
}
