use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Clone, Debug)]
pub struct SshHost {
    pub host: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Parse ~/.ssh/config into a list of concrete Host entries.
/// Wildcard patterns (`*`, `?`) are skipped since they are not directly connectable.
pub fn parse_ssh_config() -> Vec<SshHost> {
    let Some(path) = config_path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse(&content)
}

fn parse(content: &str) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    // Aliases currently collecting options (one `Host` line can declare several).
    let mut current: Vec<usize> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim(), v.trim().trim_start_matches('=').trim()),
            None => continue,
        };

        if key.eq_ignore_ascii_case("host") {
            current.clear();
            for alias in value.split_whitespace() {
                if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                    continue;
                }
                hosts.push(SshHost {
                    host: alias.to_string(),
                    hostname: None,
                    user: None,
                    port: None,
                });
                current.push(hosts.len() - 1);
            }
        } else if key.eq_ignore_ascii_case("hostname") {
            for &i in &current {
                hosts[i].hostname = Some(value.to_string());
            }
        } else if key.eq_ignore_ascii_case("user") {
            for &i in &current {
                hosts[i].user = Some(value.to_string());
            }
        } else if key.eq_ignore_ascii_case("port") {
            if let Ok(p) = value.parse::<u16>() {
                for &i in &current {
                    hosts[i].port = Some(p);
                }
            }
        }
    }
    hosts
}

#[tauri::command]
pub fn list_ssh_hosts() -> Vec<SshHost> {
    parse_ssh_config()
}
