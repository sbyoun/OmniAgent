use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Host this pod is connected to (None = local).
    host: Option<String>,
    /// Name of the tmux session backing this pod (local or remote). Killed
    /// when the pod is explicitly closed so sessions don't accumulate;
    /// preserved on app quit so the pod can restore.
    tmux_session: Option<String>,
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

    let mut cmd = match &host {
        Some(h) => {
            // Each pod gets its OWN named session on the server — opening a
            // host twice must create two independent sessions, never mirror
            // one. Falls back to a plain login shell when tmux is missing.
            let remote_cmd = match &session {
                Some(name) => format!(
                    "tmux new-session -A -s '{}' 2>/dev/null || exec $SHELL -l",
                    name.replace('\'', "")
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
                            "command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s '{}' || exec \"{}\" -l",
                            name.replace('\'', ""),
                            shell
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
            // Only the current generation may report the pod as exited.
            if is_current(&reader_id) {
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
        // never blocks closing the pod.
        if let Some(name) = inst.tmux_session {
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
