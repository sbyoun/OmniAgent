mod pty;
mod remote_fs;
mod ssh_config;

use tauri::{AppHandle, Emitter};

/// One selectable entry the frontend pushes for the Font menu. The frontend
/// (src/settings.ts) owns the font list and the active choice — they live in
/// its localStorage — so the native menu is only a projection of that state.
#[derive(serde::Deserialize)]
struct FontOption {
    key: String,
    label: String,
}

/// The two built-ins, matching `fontOptions()` in src/settings.ts. Used only to
/// build a correct menu at startup, before the frontend has pushed its state.
#[cfg(target_os = "macos")]
fn default_font_options() -> Vec<FontOption> {
    vec![
        FontOption {
            key: "default".into(),
            label: "Default · Inter / JetBrains Mono".into(),
        },
        FontOption {
            key: "d2coding".into(),
            label: "D2Coding".into(),
        },
    ]
}

/// The macOS application menu.
///
/// Tauri's default menu leaves the About panel with nothing but a version, and
/// both builds ship under the same name, icon and version — so a user looking
/// at one cannot tell which runtime they are on. Say it there, the way the
/// Electron build does. The editing items come along because the editor and
/// terminal depend on those shortcuts. View → Font is rebuilt wholesale from
/// the pushed state on every change (see `set_font_menu`).
#[cfg(target_os = "macos")]
fn build_menu(
    app: &AppHandle,
    fonts: &[FontOption],
    selected: &str,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
        SubmenuBuilder,
    };

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

    // View → Font. Each family is a check item whose id is `font:<key>`; the
    // "Add Local Font…" item opens the manager in the frontend. Clicks are
    // routed by the app-wide `on_menu_event` handler below.
    let mut font_sub = SubmenuBuilder::new(app, "Font");
    for o in fonts {
        let item = CheckMenuItemBuilder::with_id(format!("font:{}", o.key), o.label.as_str())
            .checked(o.key == selected)
            .build(app)?;
        font_sub = font_sub.item(&item);
    }
    let add_item = MenuItemBuilder::with_id("font:add", "Add Local Font…").build(app)?;
    let font_menu = font_sub.separator().item(&add_item).build()?;
    let view_menu = SubmenuBuilder::new(app, "View").item(&font_menu).build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// The frontend pushes its font list + selection here; rebuild the whole menu
/// so View → Font shows any custom families and marks the active one. A no-op
/// off macOS, where there is no application menu to rebuild.
#[tauri::command]
fn set_font_menu(app: AppHandle, options: Vec<FontOption>, selected: String) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(menu) = build_menu(&app, &options, &selected) {
            let _ = app.set_menu(menu);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &options, &selected);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // App-wide menu router: `font:add` opens the local-font manager in the
        // frontend, `font:<key>` applies that font. The frontend persists the
        // choice and re-pushes the menu (set_font_menu), so the check state
        // always follows the real setting rather than the raw click.
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            if id == "font:add" {
                let _ = app.emit("menu-add-font", ());
            } else if let Some(key) = id.strip_prefix("font:") {
                let _ = app.emit("menu-set-font", key.to_string());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle(), &default_font_options(), "default")?;
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
            pty::pty_detach,
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
            set_font_menu,
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
