mod files;
mod solver;

use solver::SolverRuntime;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SolverRuntime::default())
        .invoke_handler(tauri::generate_handler![
            solver::solve_schedule,
            solver::cancel_solve,
            solver::solver_info,
            files::save_export,
            files::import_backup,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动排班 plus桌面应用");
    application.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let runtime = app.state::<SolverRuntime>().inner().clone();
            if !runtime.closing.swap(true, Ordering::SeqCst) {
                if let Some(mut done) = runtime.cancel_active() {
                    api.prevent_exit();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if !*done.borrow() {
                            let _ = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                done.changed(),
                            )
                            .await;
                        }
                        runtime.force_shutdown();
                        handle.exit(0);
                    });
                }
            }
        }
        RunEvent::Exit => app.state::<SolverRuntime>().force_shutdown(),
        _ => {}
    });
}
