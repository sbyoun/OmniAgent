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
pub fn fs_list_dir(host: Option<String>, path: String) -> Result<Vec<DirEntry>, String> {
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
pub fn fs_read_file(host: Option<String>, path: String) -> Result<String, String> {
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
pub fn fs_write_file(host: Option<String>, path: String, content: String) -> Result<(), String> {
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
pub fn fs_mkdir(host: Option<String>, path: String) -> Result<(), String> {
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
pub fn fs_create_file(host: Option<String>, path: String) -> Result<(), String> {
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
pub fn fs_upload(request: tauri::ipc::Request<'_>) -> Result<(), String> {
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
pub fn fs_download(host: Option<String>, path: String) -> Result<String, String> {
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

/// Default working directory for a pod's explorer: $HOME locally, `~` resolved
/// remotely.
#[tauri::command]
pub fn fs_home_dir(host: Option<String>) -> Result<String, String> {
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
