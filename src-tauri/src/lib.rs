mod pty;
mod remote_fs;
mod ssh_config;

/// The macOS application menu.
///
/// Tauri's default menu leaves the About panel with nothing but a version, and
/// both builds ship under the same name, icon and version — so a user looking
/// at one cannot tell which runtime they are on. Say it there, the way the
/// Electron build does. The editing items come along because the editor and
/// terminal depend on those shortcuts.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let about = PredefinedMenuItem::about(
        app,
        Some("About OmniAgent"),
        Some(AboutMetadata {
            name: Some("OmniAgent".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            short_version: Some(format!("Tauri {} · WKWebView", tauri::VERSION)),
            copyright: Some("MIT · github.com/sbyoun/OmniAgent".into()),
            ..Default::default()
        }),
    )?;

    let app_menu = SubmenuBuilder::new(app, "OmniAgent")
        .item(&about)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle())?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            ssh_config::list_ssh_hosts,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::tmux_session_started,
            pty::tmux_sessions,
            pty::tmux_kill_session,
            pty::tmux_rename_session,
            pty::tmux_select_window,
            remote_fs::fs_list_dir,
            remote_fs::fs_read_file,
            remote_fs::fs_write_file,
            remote_fs::fs_home_dir,
            remote_fs::open_external,
            remote_fs::layout_read,
            remote_fs::layout_write,
            remote_fs::fs_mkdir,
            remote_fs::fs_create_file,
            remote_fs::fs_upload,
            remote_fs::fs_download,
            remote_fs::fs_stat,
            remote_fs::fs_read_base64,
            remote_fs::host_stats,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(mgr) = app_handle.try_state::<pty::PtyManager>() {
                    pty::kill_all_clients(&mgr);
                }
            }
        });
}
