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
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                out.push(DirEntry {
                    name: e.file_name().to_string_lossy().to_string(),
                    is_dir,
                });
            }
            sort_entries(&mut out);
            Ok(out)
        }
        Some(h) => {
            let output = ssh_base(&h)
                .arg(format!("ls -1Ap {}", shell_quote(&path)))
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
