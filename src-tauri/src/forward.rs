//! ssh tunnels from this machine to ports on a pod's server — what makes a
//! `localhost:8000` printed by a dev server inside a remote pod reachable
//! from the browser here, the way VS Code's Remote-SSH forwards ports.
//!
//! One tunnel per (host, remote port), shared by every pod on that host. Each
//! is its own `ssh -N -L` process and dies with the app: a tunnel is not
//! something to restore, since the server behind it may be gone. Mirrors
//! `electron/forward.ts`; the two shells must behave the same.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;

use crate::local;

struct Forward {
    child: Child,
    local: u16,
}

#[derive(Default, Clone)]
pub struct ForwardManager {
    forwards: Arc<Mutex<HashMap<String, Forward>>>,
}

fn key(host: &str, remote: u16) -> String {
    format!("{host}:{remote}")
}

/// The same port number when it is free here — the URL then reads the same — else any.
fn free_port(prefer: u16) -> u16 {
    let probe = |p: u16| TcpListener::bind(("127.0.0.1", p)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port());
    probe(prefer).or_else(|| probe(0)).unwrap_or(prefer)
}

fn port_up(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_ok()
}

fn open(mgr: &ForwardManager, host: &str, remote: u16) -> Result<u16, String> {
    let k = key(host, remote);
    {
        let mut map = mgr.forwards.lock().unwrap();
        if let Some(f) = map.get_mut(&k) {
            match f.child.try_wait() {
                Ok(None) => return Ok(f.local),
                _ => {
                    map.remove(&k);
                }
            }
        }
    }

    let local_port = free_port(remote);
    let spec = format!("127.0.0.1:{local_port}:localhost:{remote}");
    // `-N`: no remote command, the tunnel is the whole job. `ExitOnForwardFailure`
    // turns a port that cannot be bound into an exit instead of a silent
    // tunnel to nowhere. stdin closed outright: Windows OpenSSH never exits
    // while an inherited pipe stays open.
    let mut args: Vec<&str> = local::SSH_OPTS.to_vec();
    args.extend([
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-L",
        &spec,
        host,
    ]);
    let argv = local::local_argv("ssh", &args);
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                use std::io::Read;
                let _ = e.read_to_string(&mut err);
            }
            return Err(err.trim().lines().last().unwrap_or("ssh exited").to_string());
        }
        if port_up(local_port) {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("the tunnel did not come up".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    mgr.forwards.lock().unwrap().insert(k, Forward { child, local: local_port });
    Ok(local_port)
}

/// Open (or reuse) a tunnel to `remote` on `host`; returns the local port.
#[tauri::command]
pub async fn port_forward_open(
    state: State<'_, ForwardManager>,
    host: String,
    remote: u16,
) -> Result<u16, String> {
    // Blocks for up to ten seconds while ssh connects; keep that off the
    // async runtime's threads.
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open(&mgr, &host, remote))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn port_forward_close(state: State<'_, ForwardManager>, host: String, remote: u16) {
    if let Some(mut f) = state.forwards.lock().unwrap().remove(&key(&host, remote)) {
        let _ = f.child.kill();
    }
}

pub fn close_all(mgr: &ForwardManager) {
    let mut map = mgr.forwards.lock().unwrap();
    for (_, f) in map.iter_mut() {
        let _ = f.child.kill();
    }
    map.clear();
}
