mod files;
mod integrations;
mod solver;

use integrations::IntegrationRuntime;
use solver::SolverRuntime;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SolverRuntime::default())
        .manage(IntegrationRuntime::default())
        .invoke_handler(tauri::generate_handler![
            solver::solve_schedule,
            solver::cancel_solve,
            solver::solver_info,
            files::save_export,
            files::import_backup,
            integrations::integration_start,
            integrations::integration_stop,
            integrations::integration_status,
            integrations::integration_respond,
            integrations::integration_claim_request,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 Shift Schedule Expert 桌面应用");
    application.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            app.state::<IntegrationRuntime>().force_shutdown();
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
        RunEvent::Exit => {
            app.state::<IntegrationRuntime>().force_shutdown();
            app.state::<SolverRuntime>().force_shutdown();
        }
        _ => {}
    });
}
