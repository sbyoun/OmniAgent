mod pty;
mod remote_fs;
mod ssh_config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            ssh_config::list_ssh_hosts,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            remote_fs::fs_list_dir,
            remote_fs::fs_read_file,
            remote_fs::fs_write_file,
            remote_fs::fs_home_dir,
            remote_fs::fs_mkdir,
            remote_fs::fs_create_file,
            remote_fs::fs_upload,
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
