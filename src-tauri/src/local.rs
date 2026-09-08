//! Where "local" is.
//!
//! On macOS and Linux the app runs on the machine it manages, so a local
//! command is just a command. Windows is not that: it has no tmux to attach
//! to, no login shell worth handing an agent, and none of the ssh keys. All of
//! that lives one layer down, in WSL — so on Windows the local machine IS the
//! WSL distro, and every POSIX command the app runs locally goes through
//! `wsl.exe`: the pod's shell, `tmux ls`, the explorer's `ls`, and `ssh` out to
//! the rest of the fleet too. A pod's `~` is the distro's `~`, and the hosts in
//! the sidebar are the ones in the distro's `~/.ssh/config`, because those are
//! the ones its `ssh` can actually reach.
//!
//! The entire platform difference is the wrapper below. Off Windows
//! `on_local_machine` hands back the plain `Command` it was asked for, so
//! every call site in `pty.rs` and `remote_fs.rs` runs the same command line on
//! macOS and Linux that it ran before this file existed.
//!
//! This is the Rust half of a pair; `electron/local.ts` is the other, and the
//! two shells have to agree — they share the tmux sessions behind the pods.

use std::process::Command;

pub const LOCAL_IS_WSL: bool = cfg!(windows);

pub const SSH_OPTS: [&str; 4] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/// Which distro. Unset means whatever `wsl.exe` treats as the default, which
/// is the right answer for anyone who has one; `OMNIAGENT_WSL_DISTRO` names
/// another for anyone who keeps several and works in the second.
fn distro() -> Option<String> {
    std::env::var("OMNIAGENT_WSL_DISTRO")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Run this program on the local machine — through WSL when that is where the
/// local machine is.
///
/// `-e` is not optional. Without it wsl.exe hands the line to the default
/// shell to parse again, and the pod's `tmux … \; set-option …` does not
/// survive being parsed twice. With `-e` the argv is passed through as given,
/// which also means the multi-line `sh -c` scripts elsewhere arrive intact.
pub fn local_argv(program: &str, args: &[&str]) -> Vec<String> {
    let mut argv = Vec::with_capacity(args.len() + 4);
    if LOCAL_IS_WSL {
        argv.push("wsl.exe".to_string());
        if let Some(d) = distro() {
            argv.push("-d".to_string());
            argv.push(d);
        }
        argv.push("-e".to_string());
    }
    argv.push(program.to_string());
    argv.extend(args.iter().map(|a| a.to_string()));
    argv
}

/// `local_argv` as a `Command`, for everything that is captured rather than
/// shown — which is everything except a pod, the one command that has to be
/// launched into a terminal and so builds its argv through portable-pty.
pub fn on_local_machine(program: &str) -> Command {
    let argv = local_argv(program, &[]);
    let mut c = Command::new(&argv[0]);
    c.args(&argv[1..]);
    c
}

/// PATH for helper commands — a GUI launch inherits almost nothing, and the
/// Homebrew prefixes are where a Mac keeps tmux. Windows separates PATH with
/// `;` and finds wsl.exe in System32 regardless, so it is left alone rather
/// than given a `:`-joined entry that means nothing to it.
pub fn tool_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    if LOCAL_IS_WSL {
        inherited
    } else {
        format!("{inherited}:/opt/homebrew/bin:/usr/local/bin")
    }
}

/// One POSIX shell command, on `host` or on the local machine. The shape every
/// tmux helper wants: one short command, its stdout parsed. On Windows both
/// arms go through WSL — the remote one because the ssh that knows the host is
/// the distro's.
pub fn shell_command(host: Option<&str>, command: &str) -> Command {
    match host {
        Some(h) => {
            let mut c = on_local_machine("ssh");
            c.args(SSH_OPTS).arg(h).arg(command);
            c
        }
        None => {
            let mut c = on_local_machine("sh");
            c.arg("-c").arg(command).env("PATH", tool_path());
            c
        }
    }
}

/// The command that reaches a pod's files: `ssh` for a remote pod, and for a
/// local one on Windows the distro, which is where its files are. The caller
/// adds the command itself, since the filesystem calls all build their own.
pub fn fs_shell(host: Option<&str>) -> Command {
    match host {
        Some(h) => {
            let mut c = on_local_machine("ssh");
            c.args(SSH_OPTS).arg(h);
            c
        }
        None => {
            let mut c = on_local_machine("sh");
            c.arg("-c");
            c
        }
    }
}

/// Whether `host: None` can be answered by this process's own filesystem.
///
/// On macOS and Linux it always can, and every local call stays the plain
/// `std::fs` call it has always been. On Windows it never can: the local
/// machine is the WSL distro, and `/home/you/project` is not a path Win32 can
/// open. Those take the same command path as a remote host — `ls`, `cat`,
/// `mkdir` — with wsl.exe standing in for ssh.
pub const OWN_FS_IS_LOCAL: bool = !LOCAL_IS_WSL;
