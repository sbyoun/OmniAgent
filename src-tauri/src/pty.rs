use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Host this pod is connected to (None = local).
    host: Option<String>,
    /// Name of the tmux session backing this pod (local or remote). Killed
    /// when the pod is explicitly closed so sessions don't accumulate;
    /// preserved on app quit so the pod can restore. Cleared the moment the
    /// client exits on its own, so a connection that merely dropped can never
    /// take the session down with it.
    tmux_session: Option<String>,
    /// Whether this pod created its session. A pod opened onto a session that
    /// was already running — from the sessions list — is a guest: closing the
    /// pod must leave the work alone.
    owns_session: bool,
}

/// A stable id for the machine itself, so the fleet is grouped by box rather
/// than by the route taken to reach it: an `~/.ssh/config` can hold several
/// aliases for one server — a proxy jump from outside, a LAN address from
/// inside, a VPN address — and each would otherwise list the same sessions
/// again and poll the same machine again.
pub const MACHINE_ID: &str = r#"ID=$(cat /etc/machine-id 2>/dev/null)
[ -z "$ID" ] && ID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
[ -z "$ID" ] && ID=$(hostname)
echo "$ID""#;

#[derive(Serialize, Clone)]
pub struct SessionList {
    pub machine: String,
    pub sessions: Vec<TmuxSession>,
}

#[derive(Serialize, Clone)]
pub struct TmuxSession {
    pub name: String,
    /// Epoch seconds.
    pub created: i64,
    pub attached: bool,
    pub windows: u32,
}

/// The tmux sessions on a machine, whoever started them. Pods appear here too
/// (they are just named `omniagent-*`), so the list doubles as a way back into
/// work the app itself left running.
#[tauri::command]
pub async fn tmux_sessions(host: Option<String>) -> SessionList {
    // Both answers in one round trip; the machine id comes first.
    let query = format!(
        "{MACHINE_ID}\ntmux ls -F '#{{session_name}}\t#{{session_created}}\t#{{session_attached}}\t#{{session_windows}}' 2>/dev/null"
    );
    let out = match host {
        None => std::process::Command::new("sh")
            .arg("-c")
            .arg(&query)
            .env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output(),
        Some(h) => std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
            .arg(&query)
            .output(),
    };
    let Ok(out) = out else {
        return SessionList { machine: String::new(), sessions: Vec::new() };
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let machine = lines.next().unwrap_or("").trim().to_string();
    let sessions = lines
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut it = line.split('\t');
            Some(TmuxSession {
                name: it.next()?.to_string(),
                created: it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
                attached: it.next() == Some("1"),
                windows: it.next().and_then(|v| v.parse().ok()).unwrap_or(1),
            })
        })
        .collect();
    SessionList { machine, sessions }
}

/// Monotonic generation per spawn. A pod id can be re-spawned (e.g. webview
/// reload); events from a superseded instance must not reach the new one.
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct PtyManager {
    pub ptys: Mutex<HashMap<String, PtyInstance>>,
    pub gens: Arc<Mutex<HashMap<String, u64>>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
}

/// The pod's window list, published as the terminal title.
///
/// tmux rewrites the title whenever the window set or the active window
/// changes, so the pod header tracks `Ctrl+B c` / `Ctrl+B <n>` with no polling
/// at all. That is what makes this affordable for REMOTE pods: a
/// `tmux list-windows` poll would mean a fresh `ssh` every few seconds per pod,
/// while the title rides the pty stream that is already open.
///
/// `#{W:<inactive>,<active>}` loops the session's windows, emitting the second
/// form for the current one — so the active window arrives marked with `*`.
/// Names are cut to 12 chars and stripped of the `|` record separator; the
/// class in `s/[|]/ /` is deliberate, since a bare `|` there reads as regex
/// alternation and matches nothing. The `oa:` sentinel keeps titles set by the
/// shell or a full-screen app (the no-tmux fallback below) from being parsed
/// as windows.
///
/// Kept out of the `format!` strings below on purpose: every `{` here would
/// otherwise have to be doubled.
const TITLE_FORMAT: &str = "oa:#{W:#{window_index}:#{=12:#{s/[|]/ /:window_name}}|,#{window_index}*:#{=12:#{s/[|]/ /:window_name}}|}";

/// Spawn a PTY. `host: None` opens the local login shell; `Some(host)` runs
/// `ssh -t <host>` attaching to (or creating) a tmux session per the SDD.
/// For local pods, `session: Some(name)` wraps the shell in a named tmux
/// session (`tmux new -A`) so terminal content survives app restarts.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    host: Option<String>,
    session: Option<String>,
    rows: u16,
    cols: u16,
    owns_session: Option<bool>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // GUI apps launched from Finder inherit no locale, and a tmux client
    // without a UTF-8 LC_CTYPE treats the terminal as non-UTF-8 — dropping
    // multibyte (e.g. Korean) input and rendering existing wide glyphs as
    // underscores. Force a UTF-8 locale (keep the user's if already UTF-8).
    let lang = std::env::var("LANG")
        .ok()
        .filter(|l| l.to_ascii_uppercase().contains("UTF"))
        .unwrap_or_else(|| "en_US.UTF-8".into());
    let mut cmd = match &host {
        Some(h) => {
            // Each pod gets its OWN named session on the server — opening a
            // host twice must create two independent sessions, never mirror
            // one. Falls back to a plain login shell when tmux is missing.
            // `\; set-option status off`: the pod header already shows
            // connection state, so hide tmux's own status bar.
            // `-u` forces UTF-8 handling even when the login environment has
            // no UTF-8 locale set.
            // `set-option mouse on`: wheel scrolls tmux scrollback instead of
            // being translated into arrow keys (shell history).
            let remote_cmd = match &session {
                Some(name) => format!(
                    // `-e` pins the locale on the SESSION. Without it the
                    // shell inherits whatever environment the tmux *server*
                    // was started with — and a server left over from a
                    // non-UTF-8 launch breaks multibyte (Hangul) input while
                    // the rest of the app looks fine.
                    "tmux -u set-option -sq set-clipboard on \\; set-option -saq terminal-features 'xterm-256color:clipboard' \\; set-environment -g LANG en_US.UTF-8 \\; set-environment -g LC_CTYPE en_US.UTF-8 \\; new-session -A -s '{}' -e LANG=en_US.UTF-8 -e LC_CTYPE=en_US.UTF-8 \\; set-option status off \\; set-option mouse on \\; set-option set-titles on \\; set-option set-titles-string '{title}' 2>/dev/null || tmux -u new-session -A -s '{}' 2>/dev/null || exec $SHELL -l",
                    name.replace('\'', ""),
                    name.replace('\'', ""),
                    title = TITLE_FORMAT
                ),
                None => "exec $SHELL -l".to_string(),
            };
            let mut c = CommandBuilder::new("ssh");
            c.args(["-t", h, &remote_cmd]);
            c
        }
        None => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let mut c = CommandBuilder::new(&shell);
            match &session {
                // Attach-or-create a named tmux session so the pod's content
                // survives app restarts; fall back to a plain shell when tmux
                // is not installed.
                Some(name) => {
                    c.args([
                        "-l",
                        "-c",
                        &format!(
                            "command -v tmux >/dev/null 2>&1 && exec tmux -u set-option -sq set-clipboard on \\; set-option -saq terminal-features 'xterm-256color:clipboard' \\; set-environment -g LANG {lang} \\; set-environment -g LC_CTYPE {lang} \\; new-session -A -s '{}' -e LANG={lang} -e LC_CTYPE={lang} \\; set-option status off \\; set-option mouse on \\; set-option set-titles on \\; set-option set-titles-string '{title}' || exec \"{}\" -l",
                            name.replace('\'', ""),
                            shell,
                            lang = &lang,
                            title = TITLE_FORMAT
                        ),
                    ]);
                }
                None => {
                    c.arg("-l");
                }
            }
            c
        }
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", &lang);
    cmd.env("LC_CTYPE", &lang);
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    // Supersede any existing instance for this pod id (webview reloads spawn
    // the same id again). Kill the old client BEFORE it is dropped: the
    // master writer's Drop sends `\n`+EOF into the pty, which a live tmux
    // client would forward into the session and terminate its shell.
    let gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst);
    {
        if let Some(mut old) = state.ptys.lock().unwrap().remove(&id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        state.gens.lock().unwrap().insert(id.clone(), gen);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let reader_app = app.clone();
        let reader_id = id.clone();
        let gens = state.gens.clone();
        let my_gen = gen;
        let is_current = move |id: &str| gens.lock().unwrap().get(id) == Some(&my_gen);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // Carry bytes of a UTF-8 sequence split across read chunks so
            // multibyte characters are never emitted broken.
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let (valid, rest) = match std::str::from_utf8(&carry) {
                            Ok(s) => (s.to_string(), Vec::new()),
                            Err(e) => {
                                let v = e.valid_up_to();
                                let s = unsafe { std::str::from_utf8_unchecked(&carry[..v]) }
                                    .to_string();
                                (s, carry[v..].to_vec())
                            }
                        };
                        carry = rest;
                        // Drop output the moment this instance is superseded,
                        // so a stale client can't double-render into the pod.
                        if !is_current(&reader_id) {
                            break;
                        }
                        // A carry longer than 4 bytes is not a split char; flush lossily.
                        if carry.len() > 4 {
                            let s = String::from_utf8_lossy(&carry).to_string();
                            let _ = reader_app.emit(
                                "pty-output",
                                PtyOutput {
                                    id: reader_id.clone(),
                                    data: format!("{valid}{s}"),
                                },
                            );
                            carry.clear();
                            continue;
                        }
                        if !valid.is_empty() {
                            let _ = reader_app.emit(
                                "pty-output",
                                PtyOutput {
                                    id: reader_id.clone(),
                                    data: valid,
                                },
                            );
                        }
                    }
                }
            }
            // Only the current generation may report the pod as exited — a
            // superseded instance would otherwise disarm its own successor.
            if is_current(&reader_id) {
                // The client died on its own — a dropped ssh connection, a
                // killed tmux client, an `exit` typed into the shell.
                // Whichever it was, this instance has no claim on the tmux
                // session any more: the session outlives the connection, and
                // the pod close that may follow must not be able to reach the
                // kill-session branch in `pty_kill`. Only a still-live client
                // counts as an explicit close.
                if let Some(mgr) = reader_app.try_state::<PtyManager>() {
                    if let Ok(mut map) = mgr.ptys.lock() {
                        if let Some(inst) = map.get_mut(&reader_id) {
                            inst.tmux_session = None;
                        }
                    }
                }
                let _ = reader_app.emit("pty-exit", PtyExit { id: reader_id });
            }
        });
    }

    state.ptys.lock().unwrap().insert(
        id,
        PtyInstance {
            master: pair.master,
            writer,
            child,
            host,
            tmux_session: session,
            owns_session: owns_session.unwrap_or(true),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let inst = map.get_mut(&id).ok_or("pty not found")?;
    inst.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = state.ptys.lock().unwrap();
    let inst = map.get(&id).ok_or("pty not found")?;
    inst.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// When the pod's tmux session was created (epoch seconds). That, not the
/// moment the pod was opened, is how long the work has been running — the
/// session outlives app restarts.
#[tauri::command]
pub async fn tmux_session_started(host: Option<String>, session: String) -> Option<i64> {
    let query = format!(
        "tmux display -p -t '{}' '#{{session_created}}' 2>/dev/null",
        session.replace('\'', "")
    );
    let out = match host {
        None => std::process::Command::new("sh")
            .arg("-c")
            .arg(&query)
            .env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output()
            .ok()?,
        Some(h) => std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
            .arg(&query)
            .output()
            .ok()?,
    };
    String::from_utf8_lossy(&out.stdout).trim().parse::<i64>().ok()
}

/// Kill every pty client process. Called on app exit BEFORE state is dropped:
/// the master writer's Drop sends `\n`+EOF into the pty, and a still-attached
/// tmux client would forward that into its session and terminate the shell —
/// destroying exactly the sessions we want to restore on next launch.
pub fn kill_all_clients(mgr: &PtyManager) {
    if let Ok(mut map) = mgr.ptys.lock() {
        for (_, inst) in map.iter_mut() {
            let _ = inst.child.kill();
            let _ = inst.child.wait();
        }
    }
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    state.gens.lock().unwrap().remove(&id);
    if let Some(mut inst) = map.remove(&id) {
        let _ = inst.child.kill();
        // Explicit close: tear down the pod's backing tmux session too
        // (local or remote). Done on a thread so a slow ssh round-trip
        // never blocks closing the pod. A client that had already exited
        // cleared `tmux_session` on the way out, so a dropped connection —
        // and the pod teardown that follows it — leaves the work running.
        if let Some(name) = inst.tmux_session.filter(|_| inst.owns_session) {
            let host = inst.host;
            std::thread::spawn(move || match host {
                None => {
                    let _ = std::process::Command::new("tmux")
                        .args(["kill-session", "-t", &name])
                        .env(
                            "PATH",
                            format!(
                                "{}:/opt/homebrew/bin:/usr/local/bin",
                                std::env::var("PATH").unwrap_or_default()
                            ),
                        )
                        .output();
                }
                Some(h) => {
                    let _ = std::process::Command::new("ssh")
                        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
                        .arg(format!("tmux kill-session -t '{}'", name.replace('\'', "")))
                        .output();
                }
            });
        }
    }
    Ok(())
}

/// Detach a pod — the ⌘/Ctrl+W close. Tears down the client exactly as
/// `pty_kill` does (drop the generation, kill the child) but never touches the
/// tmux session: the work keeps running and the pod reattaches to it on the
/// next launch. The panel teardown that follows sends `pty_kill`, which finds
/// nothing left and no-ops — so this must land first, which the caller ensures
/// by awaiting it before closing the panel.
#[tauri::command]
pub fn pty_detach(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    state.gens.lock().unwrap().remove(&id);
    if let Some(mut inst) = map.remove(&id) {
        let _ = inst.child.kill();
    }
    Ok(())
}

/// End a session from the sessions list, whoever started it.
#[tauri::command]
pub async fn tmux_kill_session(host: Option<String>, name: String) {
    let command = format!("tmux kill-session -t '{}'", name.replace('\'', ""));
    let _ = match host {
        None => std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output(),
        Some(h) => std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
            .arg(&command)
            .output(),
    };
}

/// Switch the session to one of its windows — what clicking a window in the pod
/// header does.
///
/// Deliberately NOT typed into the pty as `<prefix> <n>`. That looks simpler and
/// works for single digits, but tmux only binds the digit keys 0-9, and driving
/// its command prompt instead (`<prefix> : select-window …`) turns out not to
/// work at all through a pty write. Walking there with `next-window` does work,
/// but only when the keystrokes are spaced out — sent as one burst tmux acts on
/// just the first. Asking the server directly sidesteps all of it, and works the
/// same for a guest pod whose owner rebound the prefix.
#[tauri::command]
pub async fn tmux_select_window(host: Option<String>, session: String, index: i64) {
    let command = format!(
        "tmux select-window -t '{}:{}'",
        session.replace('\'', ""),
        index
    );
    let _ = match host {
        None => std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output(),
        Some(h) => std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
            .arg(&command)
            .output(),
    };
}

/// Rename a session, so naming a pod carries through to `tmux ls` and to the
/// sessions panel. Returns false when the name is taken.
#[tauri::command]
pub async fn tmux_rename_session(host: Option<String>, from: String, to: String) -> bool {
    let command = format!(
        "tmux rename-session -t '{}' '{}'",
        from.replace('\'', ""),
        to.replace('\'', "")
    );
    let out = match host {
        None => std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output(),
        Some(h) => std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", &h])
            .arg(&command)
            .output(),
    };
    out.map(|o| o.status.success()).unwrap_or(false)
}
